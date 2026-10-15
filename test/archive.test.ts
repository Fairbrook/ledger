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
import { RcloneRemote, type RemoteStore } from '../src/main/remote'

/** A remote backed by a plain directory, with switches to simulate failures. */
class FakeRemote implements RemoteStore {
  failCheck = false
  failUpload = false
  constructor(readonly dir: string) {}
  private p = (rel: string) => path.join(this.dir, rel)
  async copyDir(localDir: string, rel: string) {
    fs.mkdirSync(this.p(rel), { recursive: true })
    fs.cpSync(localDir, this.p(rel), { recursive: true })
  }
  async copyFile(local: string, rel: string) {
    if (this.failUpload) throw new Error('network down')
    fs.mkdirSync(path.dirname(this.p(rel)), { recursive: true })
    fs.copyFileSync(local, this.p(rel))
  }
  async checkDir() {
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
