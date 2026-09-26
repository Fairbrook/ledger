import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { comparisonToCsv } from '../src/main/csv'
import { openDatabase } from '../src/main/db'
import { Ledger, uniquePath } from '../src/main/ledger'
import type { ExperimentInput, RunInput } from '../src/shared/types'

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'))
  const db = openDatabase(path.join(root, 'ledger.db'))
  const ledger = new Ledger(db, path.join(root, 'files'))
  return {
    root,
    ledger,
    done: () => {
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
}

const exp = (patch: Partial<ExperimentInput> = {}): ExperimentInput => ({
  name: 'PID tuning',
  subject: 'Altitude controller',
  objective: 'Find gains with < 5% overshoot',
  description: '',
  conclusions: '',
  status: 'running',
  ...patch
})

const run = (patch: Partial<RunInput> = {}): RunInput => ({
  title: '',
  date: '2026-09-01T10:00',
  params: [],
  notes: '',
  outcome: 'pending',
  ...patch
})

test('experiments: validation, update and listing', () => {
  const { ledger, done } = setup()
  try {
    assert.throws(() => ledger.createExperiment(exp({ name: '  ' })), /name is required/)
    const e = ledger.createExperiment(exp({ name: '  PID tuning ' }))
    assert.equal(e.name, 'PID tuning')
    assert.equal(e.runCount, 0)
    const u = ledger.updateExperiment(e.id, exp({ conclusions: 'Kp=1.2 works best', status: 'concluded' }))
    assert.equal(u.status, 'concluded')
    assert.equal(u.conclusions, 'Kp=1.2 works best')
    assert.deepEqual(ledger.listExperiments().map((x) => x.id), [e.id])
  } finally {
    done()
  }
})

test('runs are numbered in order and keep their parameters', () => {
  const { ledger, done } = setup()
  try {
    const e = ledger.createExperiment(exp())
    const r1 = ledger.createRun(e.id, run({ params: [{ key: 'Kp', value: '1.0' }, { key: 'Ki', value: '0.1' }] }))
    const r2 = ledger.createRun(e.id, run({ params: [{ key: 'Kp', value: '1.2' }, { key: '', value: '' }] }))
    assert.deepEqual([r1.seq, r2.seq], [1, 2])
    assert.deepEqual(r1.params, [{ key: 'Kp', value: '1.0' }, { key: 'Ki', value: '0.1' }])
    assert.deepEqual(r2.params, [{ key: 'Kp', value: '1.2' }])

    assert.throws(() => ledger.createRun(e.id, run({ params: [{ key: 'a', value: '1' }, { key: 'a', value: '2' }] })), /twice/)
    assert.throws(() => ledger.createRun(e.id, run({ date: '' })), /date/)
    assert.throws(() => ledger.createRun(999, run()), /not found/)
    // A failed create doesn't burn a sequence number.
    assert.equal(ledger.createRun(e.id, run()).seq, 3)

    const updated = ledger.updateRun(r1.id, run({ outcome: 'success', notes: 'Stable', params: [{ key: 'Kp', value: '0.9' }] }))
    assert.equal(updated.outcome, 'success')
    assert.deepEqual(updated.params, [{ key: 'Kp', value: '0.9' }])
    assert.equal(ledger.getExperiment(e.id).runCount, 3)
  } finally {
    done()
  }
})

test('results: batch add is atomic and values must be numeric', () => {
  const { ledger, done } = setup()
  try {
    const e = ledger.createExperiment(exp())
    const r = ledger.createRun(e.id, run())
    assert.throws(
      () => ledger.addResults(r.id, [{ label: 'overshoot', value: 4, unit: '%' }, { label: 'rise', value: NaN, unit: 's' }]),
      /numeric/
    )
    assert.equal(ledger.listResults(r.id).length, 0)
    const [a] = ledger.addResults(r.id, [{ label: 'overshoot', value: 4, unit: '%' }, { label: 'rise', value: 0.8, unit: 's' }])
    assert.equal(ledger.getRun(r.id).resultCount, 2)
    assert.equal(ledger.updateResult(a.id, { label: 'overshoot', value: 3.5, unit: '%' }).value, 3.5)
    ledger.deleteResult(a.id)
    assert.deepEqual(ledger.listResults(r.id).map((x) => x.label), ['rise'])
  } finally {
    done()
  }
})

test('files are copied into <root>/<experiment>/<run>/ with numbered duplicates', () => {
  const { root, ledger, done } = setup()
  try {
    const e = ledger.createExperiment(exp())
    const r = ledger.createRun(e.id, run())
    const src = path.join(root, 'output.csv')
    fs.writeFileSync(src, 'a,b\n1,2\n')

    const files = ledger.attachFiles(r.id, [src, src, src])
    assert.deepEqual(
      files.map((f) => f.storedPath),
      [`${e.id}/${r.id}/output.csv`, `${e.id}/${r.id}/output_1.csv`, `${e.id}/${r.id}/output_2.csv`]
    )
    assert.ok(files.every((f) => f.filename === 'output.csv' && f.sizeBytes === 8))
    assert.ok(fs.existsSync(src), 'source is copied, not moved')
    for (const f of files) assert.ok(fs.existsSync(ledger.filePath(f)))

    // A missing source aborts the whole batch and cleans up what was copied.
    assert.throws(() => ledger.attachFiles(r.id, [src, path.join(root, 'nope.bin')]))
    assert.equal(ledger.listFiles(r.id).length, 3)
    assert.equal(fs.readdirSync(ledger.runDir(e.id, r.id)).length, 3)

    ledger.deleteFile(files[1].id)
    assert.ok(!fs.existsSync(ledger.filePath(files[1])))
    assert.equal(ledger.listFiles(r.id).length, 2)
  } finally {
    done()
  }
})

test('deleting a run or experiment cascades to results, files and stored files', () => {
  const { root, ledger, done } = setup()
  try {
    const src = path.join(root, 'log.txt')
    fs.writeFileSync(src, 'hello')
    const e = ledger.createExperiment(exp())
    const r1 = ledger.createRun(e.id, run({ params: [{ key: 'x', value: '1' }] }))
    const r2 = ledger.createRun(e.id, run())
    ledger.addResults(r1.id, [{ label: 'm', value: 1, unit: '' }])
    const [f1] = ledger.attachFiles(r1.id, [src])
    ledger.attachFiles(r2.id, [src])

    ledger.deleteRun(r1.id)
    assert.ok(!fs.existsSync(ledger.runDir(e.id, r1.id)))
    assert.throws(() => ledger.getFile(f1.id), /not found/)
    assert.equal(ledger.listResults(r1.id).length, 0)
    assert.deepEqual(ledger.listRuns(e.id).map((r) => r.seq), [2])

    ledger.deleteExperiment(e.id)
    assert.equal(ledger.listExperiments().length, 0)
    assert.ok(!fs.existsSync(path.join(ledger.filesRoot, String(e.id))))
    assert.equal(ledger.listRuns(e.id).length, 0)
  } finally {
    done()
  }
})

test('comparison lines up params and metrics per run, and exports to CSV', () => {
  const { ledger, done } = setup()
  try {
    const e = ledger.createExperiment(exp())
    const r1 = ledger.createRun(e.id, run({ title: 'baseline', params: [{ key: 'Kp', value: '1.0' }] }))
    const r2 = ledger.createRun(e.id, run({ title: 'more "gain", less damping', params: [{ key: 'Kp', value: '1.5' }, { key: 'Kd', value: '0.2' }] }))
    ledger.addResults(r1.id, [{ label: 'overshoot', value: 4, unit: '%' }, { label: 'overshoot', value: 6, unit: '%' }])
    ledger.addResults(r2.id, [{ label: 'rise', value: 0.5, unit: 's' }, { label: 'overshoot', value: 9, unit: '%' }])

    const c = ledger.compare(e.id)
    assert.deepEqual(c.paramKeys, ['Kp', 'Kd'])
    assert.deepEqual(c.metrics, [{ label: 'overshoot', unit: '%' }, { label: 'rise', unit: 's' }])
    assert.equal(c.values[r1.id]['overshoot\u0000%'], 5)

    assert.equal(
      comparisonToCsv(c),
      'run,title,date,outcome,Kp,Kd,overshoot [%],rise [s]\n' +
        '1,baseline,2026-09-01T10:00,pending,1.0,,5,\n' +
        '2,"more ""gain"", less damping",2026-09-01T10:00,pending,1.5,0.2,9,0.5\n'
    )
  } finally {
    done()
  }
})

test('uniquePath handles names without extensions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'))
  try {
    fs.writeFileSync(path.join(dir, 'README'), '')
    fs.writeFileSync(path.join(dir, '.env'), '')
    assert.equal(path.basename(uniquePath(dir, 'README')), 'README_1')
    assert.equal(path.basename(uniquePath(dir, '.env')), '.env_1')
    assert.equal(path.basename(uniquePath(dir, 'new.txt')), 'new.txt')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
