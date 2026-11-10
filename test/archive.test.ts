import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { RemoteSync } from '../src/main/archive'
import { openDatabase } from '../src/main/db'
import { startApiServer } from '../src/main/http'
import { Ledger } from '../src/main/ledger'
import { RcloneRemote, isCancelled, type RemoteStore, type TransferOpts } from '../src/main/remote'
import type { ArchiveProgress } from '../src/shared/types'

/** A remote backed by a plain directory, with switches to simulate failures. */
class FakeRemote implements RemoteStore {
  failCheck = false
  failUpload = false
  /** When set, copyDir waits for it (or for the abort signal) before copying. */
  gate: Promise<void> | null = null
  constructor(readonly dir: string) {}
  private p = (rel: string) => path.join(this.dir, rel)
  async copyDir(localDir: string, rel: string, opts?: TransferOpts) {
    const stats = { bytes: 1, totalBytes: 2, transfers: 0, totalTransfers: 1, checks: 0, totalChecks: 0, eta: null }
    opts?.onProgress?.(stats)
    if (this.gate) {
      await new Promise<void>((resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' })))
        this.gate!.then(resolve)
      })
    }
    fs.mkdirSync(this.p(rel), { recursive: true })
    fs.cpSync(localDir, this.p(rel), { recursive: true })
  }
  async copyFile(local: string, rel: string) {
    if (this.failUpload) throw new Error('network down')
    fs.mkdirSync(path.dirname(this.p(rel)), { recursive: true })
    fs.copyFileSync(local, this.p(rel))
  }
  async checkDir(_localDir: string, _rel: string, opts?: TransferOpts) {
    opts?.onProgress?.({ bytes: 0, totalBytes: 0, transfers: 0, totalTransfers: 0, checks: 1, totalChecks: 1, eta: null })
    if (this.failCheck) throw new Error('checksum mismatch')
  }
  async download(rel: string, localDir: string) {
    fs.mkdirSync(localDir, { recursive: true })
    fs.cpSync(this.p(rel), localDir, { recursive: true })
  }
  async purge(rel: string) {
    fs.rmSync(this.p(rel), { recursive: true, force: true })
  }
  async deleteFile(rel: string) {
    fs.rmSync(this.p(rel), { force: true })
  }
  async test() {
    return 'fake'
  }
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'))
  const db = openDatabase(path.join(root, 'ledger.db'))
  const ledger = new Ledger(db, path.join(root, 'files'))
  const remote = new FakeRemote(path.join(root, 'remote'))
  const sync = new RemoteSync(ledger, () => remote)
  const exp = ledger.createExperiment({
    name: 'E',
    subject: '',
    objective: '',
    description: '',
    conclusions: '',
    status: 'running'
  })
  const run = ledger.createRun(exp.id, { title: '', date: '2026-09-01', params: [], notes: '', outcome: 'pending' })
  const src = path.join(root, 'out.csv')
  fs.writeFileSync(src, 'a,b\n1,2\n')
  return {
    root,
    ledger,
    remote,
    sync,
    exp,
    run,
    src,
    done: () => {
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
}

test('the backup queue uploads pending files and records it', async () => {
  const { ledger, sync, remote, run, exp, src, done } = setup()
  try {
    const [f] = ledger.attachFiles(run.id, [src])
    assert.equal(ledger.pendingBackups().length, 1)
    assert.equal(sync.status().pending, 1)

    remote.failUpload = true
    await sync.kick()
    assert.equal(ledger.pendingBackups().length, 1, 'failed upload stays pending')
    assert.match(sync.status().lastError ?? '', /network down/)

    remote.failUpload = false
    await sync.kick()
    assert.equal(ledger.pendingBackups().length, 0)
    assert.equal(sync.status().lastError, null)
    assert.ok(ledger.getFile(f.id).backedUpAt)
    assert.ok(fs.existsSync(path.join(remote.dir, String(exp.id), String(run.id), 'out.csv')))
  } finally {
    done()
  }
})

test('archive deletes local files but keeps records; restore brings them back', async () => {
  const { ledger, sync, run, src, done } = setup()
  try {
    const [f] = ledger.attachFiles(run.id, [src])
    const archived = await sync.archiveRun(run.id)
    assert.ok(archived.archivedAt)
    assert.ok(!fs.existsSync(ledger.runDir(run.experimentId, run.id)))
    assert.equal(ledger.listFiles(run.id).length, 1, 'file record is kept')
    assert.ok(ledger.getFile(f.id).backedUpAt)
    assert.throws(() => ledger.assertLocal(f), /archived/)
    assert.throws(() => ledger.attachFiles(run.id, [src]), /archived/)
    await assert.rejects(sync.archiveRun(run.id), /already archived/)

    const restored = await sync.restoreRun(run.id)
    assert.equal(restored.archivedAt, null)
    assert.equal(fs.readFileSync(ledger.filePath(f), 'utf8'), 'a,b\n1,2\n')
    ledger.assertLocal(f)
    await assert.rejects(sync.restoreRun(run.id), /not archived/)
  } finally {
    done()
  }
})

test('nested files survive archive and restore at the same path', async () => {
  const { ledger, sync, run, src, done } = setup()
  try {
    const [f] = ledger.attachFiles(run.id, [src], { into: 'plots/run1' })
    await sync.archiveRun(run.id)
    assert.ok(!fs.existsSync(ledger.runDir(run.experimentId, run.id)))
    await sync.restoreRun(run.id)
    assert.equal(f.filename, 'plots/run1/' + path.basename(src))
    assert.equal(fs.readFileSync(ledger.filePath(f), 'utf8'), 'a,b\n1,2\n')
  } finally {
    done()
  }
})

test('a failed verification leaves the run and its local files untouched', async () => {
  const { ledger, sync, remote, run, src, done } = setup()
  try {
    ledger.attachFiles(run.id, [src])
    remote.failCheck = true
    await assert.rejects(sync.archiveRun(run.id), /checksum mismatch/)
    assert.equal(ledger.getRun(run.id).archivedAt, null)
    assert.ok(fs.existsSync(ledger.runDir(run.experimentId, run.id)))
    assert.equal(ledger.pendingBackups().length, 1)
  } finally {
    done()
  }
})

test('archiving needs a configured remote', async () => {
  const { ledger, run, done } = setup()
  try {
    const sync = new RemoteSync(ledger, () => null)
    await assert.rejects(sync.archiveRun(run.id), /No remote configured/)
    assert.equal(sync.status().configured, false)
  } finally {
    done()
  }
})

test('forget removes remote copies of a run, a file or an experiment', async () => {
  const { ledger, sync, remote, run, exp, src, done } = setup()
  try {
    const [f] = ledger.attachFiles(run.id, [src])
    await sync.kick()
    const runDir = path.join(remote.dir, String(exp.id), String(run.id))
    await sync.forget({ experimentId: exp.id, filePath: f.storedPath })
    assert.ok(!fs.existsSync(path.join(runDir, 'out.csv')))
    fs.mkdirSync(runDir, { recursive: true })
    await sync.forget({ experimentId: exp.id, runId: run.id })
    assert.ok(!fs.existsSync(runDir))
    await sync.forget({ experimentId: exp.id })
    assert.ok(!fs.existsSync(path.join(remote.dir, String(exp.id))))
  } finally {
    done()
  }
})

test('http: archive and restore endpoints', async () => {
  const { ledger, sync, run, src, done } = setup()
  ledger.attachFiles(run.id, [src])
  const { server, url } = await startApiServer(ledger, { port: 0, sync })
  const post = async (p: string) => {
    const res = await fetch(url + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    return { status: res.status, body: (await res.json()) as any }
  }
  try {
    const a = await post(`/runs/${run.id}/archive`)
    assert.equal(a.status, 200)
    assert.ok(a.body.archivedAt)
    assert.equal((await post(`/runs/${run.id}/archive`)).status, 400)
    const r = await post(`/runs/${run.id}/restore`)
    assert.equal(r.status, 200)
    assert.equal(r.body.archivedAt, null)
  } finally {
    server.close()
    done()
  }
})

test('archive reports phases in order and clears its state afterwards', async () => {
  const { ledger, remote, run, src, done } = setup()
  try {
    const seen: ArchiveProgress[] = []
    const sync = new RemoteSync(ledger, () => remote, undefined, (p) => seen.push(p))
    ledger.attachFiles(run.id, [src])
    await sync.archiveRun(run.id)
    const phases = seen.map((p) => p.phase).filter((phase, i, all) => phase !== all[i - 1])
    assert.deepEqual(phases, ['uploading', 'verifying', 'removing'])
    assert.ok(seen.every((p) => p.runId === run.id && p.op === 'archive'))
    assert.equal(seen[0].totalBytes, fs.statSync(src).size, 'expected size comes from the local files')
    assert.deepEqual(sync.activeTransfers(), [])

    seen.length = 0
    await sync.restoreRun(run.id)
    assert.deepEqual([...new Set(seen.map((p) => p.phase))], ['downloading'])
    assert.equal(seen[0].op, 'restore')
  } finally {
    done()
  }
})

test('cancelling an upload keeps the run local and lets it be archived again', async () => {
  const { ledger, remote, run, src, done } = setup()
  try {
    const sync = new RemoteSync(ledger, () => remote)
    ledger.attachFiles(run.id, [src])
    let release!: () => void
    remote.gate = new Promise<void>((resolve) => (release = resolve))

    const pending = sync.archiveRun(run.id)
    assert.equal(sync.activeTransfers().length, 1)
    sync.cancel(run.id)
    await assert.rejects(pending, (err) => isCancelled(err) && /Cancelled/.test((err as Error).message))
    assert.equal(ledger.getRun(run.id).archivedAt, null)
    assert.ok(fs.existsSync(ledger.runDir(run.experimentId, run.id)))
    assert.deepEqual(sync.activeTransfers(), [])

    remote.gate = null
    release()
    assert.ok((await sync.archiveRun(run.id)).archivedAt, 'the run is not stuck as busy')
  } finally {
    done()
  }
})

const hasRclone = (() => {
  try {
    execFileSync('rclone', ['version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

test('rclone: round trip against a local-directory remote', { skip: !hasRclone && 'rclone not installed' }, async () => {
  const { ledger, run, src, root, done } = setup()
  try {
    const remote = new RcloneRemote('rclone', path.join(root, 'rclone-remote'))
    const sync = new RemoteSync(ledger, () => remote)
    const [f] = ledger.attachFiles(run.id, [src])
    assert.match(await remote.test(), /reachable/)
    await sync.archiveRun(run.id)
    assert.ok(!fs.existsSync(ledger.filePath(f)))
    await sync.restoreRun(run.id)
    assert.equal(fs.readFileSync(ledger.filePath(f), 'utf8'), 'a,b\n1,2\n')
    await sync.forget({ experimentId: run.experimentId, runId: run.id })
    await remote.purge('does/not/exist') // missing folders are not an error
  } finally {
    done()
  }
})

/** A fake `rclone` executable: logs its arguments, prints JSON stats lines, and can report missing hashes. */
function stubRclone(root: string, opts: { noHash?: boolean; fail?: boolean } = {}) {
  const log = path.join(root, 'rclone-args.log')
  const bin = path.join(root, 'rclone-stub')
  const stats = '{"level":"notice","msg":"stats","stats":{"bytes":50,"totalBytes":100,"transfers":1,"totalTransfers":2,"checks":0,"totalChecks":0,"eta":7}}'
  fs.writeFileSync(
    bin,
    [
      '#!/bin/sh',
      `echo "$*" >> '${log}'`,
      `echo '${stats}' >&2`,
      opts.noHash ? `case "$*" in *--download*) ;; *) echo '{"level":"notice","msg":"2 hashes could not be checked"}' >&2 ;; esac` : '',
      opts.fail ? `echo '{"level":"error","msg":"boom: quota exceeded"}' >&2; exit 1` : '',
      'exit 0'
    ].join('\n'),
    { mode: 0o755 }
  )
  return { bin, calls: () => fs.readFileSync(log, 'utf8').trim().split('\n') }
}

test('rclone runner forwards stats as progress and surfaces error lines', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-stub-'))
  try {
    const ok = stubRclone(root)
    const seen: unknown[] = []
    await new RcloneRemote(ok.bin, 'r:base').copyDir('/tmp/x', '1/2', { onProgress: (s) => seen.push(s) })
    assert.deepEqual(seen, [{ bytes: 50, totalBytes: 100, transfers: 1, totalTransfers: 2, checks: 0, totalChecks: 0, eta: 7 }])
    assert.match(ok.calls()[0], /^copy \/tmp\/x r:base\/1\/2 --retries 3 --use-json-log --stats 1s/)

    const bad = stubRclone(root, { fail: true })
    await assert.rejects(new RcloneRemote(bad.bin, 'r:base').copyDir('/tmp/x', '1/2', { onProgress() {} }), /boom: quota exceeded/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('rclone check only reads content back when there is no common hash', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-stub-'))
  try {
    const hashed = stubRclone(root)
    await new RcloneRemote(hashed.bin, 'r:base').checkDir('/tmp/x', '1/2')
    assert.equal(hashed.calls().length, 1)
    assert.ok(!hashed.calls()[0].includes('--download'))
    fs.rmSync(path.join(root, 'rclone-args.log'))

    const hashless = stubRclone(root, { noHash: true })
    await new RcloneRemote(hashless.bin, 'r:base').checkDir('/tmp/x', '1/2')
    assert.equal(hashless.calls().length, 2)
    assert.ok(hashless.calls()[1].includes('--download'))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
