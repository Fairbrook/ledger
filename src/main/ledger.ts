import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { transaction } from './db'
import {
  EXPERIMENT_STATUSES,
  RUN_OUTCOMES,
  metricKey,
  type Comparison,
  type Experiment,
  type ExperimentInput,
  type Result,
  type ResultInput,
  type Run,
  type RunFile,
  type RunInput,
  type RunParam
} from '../shared/types'

type Row = Record<string, unknown>

const now = () => new Date().toISOString()

/**
 * All experiment data: SQLite for records, plus a managed folder for attached files:
 *   <filesRoot>/<experimentId>/<runId>/<original file name>
 * The renderer never touches either directly; everything goes through this class via IPC.
 */
export class Ledger {
  constructor(
    private readonly db: DatabaseSync,
    readonly filesRoot: string
  ) {
    fs.mkdirSync(filesRoot, { recursive: true })
  }

  // ---- experiments ----------------------------------------------------------

  listExperiments(): Experiment[] {
    const rows = this.db
      .prepare(
        `SELECT e.*, (SELECT count(*) FROM runs r WHERE r.experiment_id = e.id) AS run_count
         FROM experiments e ORDER BY e.updated_at DESC, e.id DESC`
      )
      .all() as Row[]
    return rows.map(toExperiment)
  }

  getExperiment(id: number): Experiment {
    const row = this.db
      .prepare(
        `SELECT e.*, (SELECT count(*) FROM runs r WHERE r.experiment_id = e.id) AS run_count
         FROM experiments e WHERE e.id = ?`
      )
      .get(id) as Row | undefined
    if (!row) throw new Error(`Experiment ${id} not found`)
    return toExperiment(row)
  }

  createExperiment(input: ExperimentInput): Experiment {
    const e = cleanExperiment(input)
    const ts = now()
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO experiments (name, subject, objective, description, conclusions, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(e.name, e.subject, e.objective, e.description, e.conclusions, e.status, ts, ts)
    return this.getExperiment(Number(lastInsertRowid))
  }

  updateExperiment(id: number, input: ExperimentInput): Experiment {
    const e = cleanExperiment(input)
    const { changes } = this.db
      .prepare(
        `UPDATE experiments SET name = ?, subject = ?, objective = ?, description = ?, conclusions = ?, status = ?,
         updated_at = ? WHERE id = ?`
      )
      .run(e.name, e.subject, e.objective, e.description, e.conclusions, e.status, now(), id)
    if (!changes) throw new Error(`Experiment ${id} not found`)
    return this.getExperiment(id)
  }

  /** Deletes the experiment, its runs, results and file records (FK cascade), and its stored files. */
  deleteExperiment(id: number): void {
    this.db.prepare('DELETE FROM experiments WHERE id = ?').run(id)
    fs.rmSync(path.join(this.filesRoot, String(id)), { recursive: true, force: true })
  }

  private touchExperiment(id: number) {
    this.db.prepare('UPDATE experiments SET updated_at = ? WHERE id = ?').run(now(), id)
  }

  // ---- runs -------------------------------------------------------------------

  listRuns(experimentId: number): Run[] {
    const rows = this.db
      .prepare(`${RUN_SELECT} WHERE r.experiment_id = ? ORDER BY r.seq`)
      .all(experimentId) as Row[]
    return this.withParams(rows.map(toRun))
  }

  getRun(id: number): Run {
    const row = this.db.prepare(`${RUN_SELECT} WHERE r.id = ?`).get(id) as Row | undefined
    if (!row) throw new Error(`Run ${id} not found`)
    return this.withParams([toRun(row)])[0]
  }

  createRun(experimentId: number, input: RunInput): Run {
    const r = cleanRun(input)
    const id = transaction(this.db, () => {
      this.getExperiment(experimentId)
      const { next } = this.db
        .prepare('SELECT coalesce(max(seq), 0) + 1 AS next FROM runs WHERE experiment_id = ?')
        .get(experimentId) as { next: number }
      const ts = now()
      const { lastInsertRowid } = this.db
        .prepare(
          `INSERT INTO runs (experiment_id, seq, title, date, notes, outcome, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(experimentId, next, r.title, r.date, r.notes, r.outcome, ts, ts)
      const runId = Number(lastInsertRowid)
      this.writeParams(runId, r.params)
      this.touchExperiment(experimentId)
      return runId
    })
    return this.getRun(id)
  }

  updateRun(id: number, input: RunInput): Run {
    const r = cleanRun(input)
    transaction(this.db, () => {
      const { experimentId } = this.getRun(id)
      this.db
        .prepare('UPDATE runs SET title = ?, date = ?, notes = ?, outcome = ?, updated_at = ? WHERE id = ?')
        .run(r.title, r.date, r.notes, r.outcome, now(), id)
      this.writeParams(id, r.params)
      this.touchExperiment(experimentId)
    })
    return this.getRun(id)
  }

  /** Deletes the run, its results and file records, and its stored files. Other runs keep their numbers. */
  deleteRun(id: number): void {
    const run = this.getRun(id)
    this.db.prepare('DELETE FROM runs WHERE id = ?').run(id)
    this.touchExperiment(run.experimentId)
    fs.rmSync(this.runDir(run.experimentId, id), { recursive: true, force: true })
  }

  private writeParams(runId: number, params: RunParam[]) {
    this.db.prepare('DELETE FROM run_params WHERE run_id = ?').run(runId)
    const insert = this.db.prepare('INSERT INTO run_params (run_id, position, key, value) VALUES (?, ?, ?, ?)')
    params.forEach((p, i) => insert.run(runId, i, p.key, p.value))
  }

  private withParams(runs: Run[]): Run[] {
    if (runs.length === 0) return runs
    const byId = new Map(runs.map((r) => [r.id, r]))
    const rows = this.db
      .prepare(
        `SELECT run_id, key, value FROM run_params
         WHERE run_id IN (${runs.map(() => '?').join(',')}) ORDER BY run_id, position`
      )
      .all(...runs.map((r) => r.id)) as Row[]
    for (const row of rows) byId.get(Number(row.run_id))?.params.push({ key: String(row.key), value: String(row.value) })
    return runs
  }

  // ---- results ----------------------------------------------------------------

  listResults(runId: number): Result[] {
    return (this.db.prepare('SELECT * FROM results WHERE run_id = ? ORDER BY id').all(runId) as Row[]).map(toResult)
  }

  /** Adds several results atomically: either all are stored or none. */
  addResults(runId: number, inputs: ResultInput[]): Result[] {
    const clean = inputs.map(cleanResult)
    const ids = transaction(this.db, () => {
      const run = this.getRun(runId)
      const insert = this.db.prepare('INSERT INTO results (run_id, label, value, unit) VALUES (?, ?, ?, ?)')
      const out = clean.map((r) => Number(insert.run(runId, r.label, r.value, r.unit).lastInsertRowid))
      this.touchExperiment(run.experimentId)
      return out
    })
    return ids.map((id) => this.getResult(id))
  }

  getResult(id: number): Result {
    const row = this.db.prepare('SELECT * FROM results WHERE id = ?').get(id) as Row | undefined
    if (!row) throw new Error(`Result ${id} not found`)
    return toResult(row)
  }

  updateResult(id: number, input: ResultInput): Result {
    const r = cleanResult(input)
    const { changes } = this.db
      .prepare('UPDATE results SET label = ?, value = ?, unit = ? WHERE id = ?')
      .run(r.label, r.value, r.unit, id)
    if (!changes) throw new Error(`Result ${id} not found`)
    return this.getResult(id)
  }

  deleteResult(id: number): void {
    this.db.prepare('DELETE FROM results WHERE id = ?').run(id)
  }

  // ---- files ------------------------------------------------------------------

  runDir(experimentId: number, runId: number): string {
    return path.join(this.filesRoot, String(experimentId), String(runId))
  }

  listFiles(runId: number): RunFile[] {
    return (this.db.prepare('SELECT * FROM files WHERE run_id = ? ORDER BY id').all(runId) as Row[]).map(toFile)
  }

  getFile(id: number): RunFile {
    const row = this.db.prepare('SELECT * FROM files WHERE id = ?').get(id) as Row | undefined
    if (!row) throw new Error(`File ${id} not found`)
    return toFile(row)
  }

  /** Absolute path of a stored file. */
  filePath(file: RunFile): string {
    return path.join(this.filesRoot, file.storedPath)
  }

  /**
   * Copies (never moves) each source file into the run's folder, renaming on name clashes
   * (out.csv → out_1.csv), and records them. All-or-nothing: on failure, copies made so far are removed.
   */
  attachFiles(runId: number, sourcePaths: string[]): RunFile[] {
    const run = this.getRun(runId)
    const dir = this.runDir(run.experimentId, runId)
    fs.mkdirSync(dir, { recursive: true })
    const copied: string[] = []
    try {
      const ids = transaction(this.db, () => {
        const insert = this.db.prepare(
          'INSERT INTO files (run_id, filename, stored_path, size_bytes, created_at) VALUES (?, ?, ?, ?, ?)'
        )
        const out = sourcePaths.map((src) => {
          const stat = fs.statSync(src)
          if (!stat.isFile()) throw new Error(`${src} is not a file`)
          const filename = path.basename(src)
          const dest = uniquePath(dir, filename)
          fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL)
          copied.push(dest)
          const rel = path.relative(this.filesRoot, dest).split(path.sep).join('/')
          return Number(insert.run(runId, filename, rel, stat.size, now()).lastInsertRowid)
        })
        this.touchExperiment(run.experimentId)
        return out
      })
      return ids.map((id) => this.getFile(id))
    } catch (err) {
      for (const f of copied) fs.rmSync(f, { force: true })
      throw err
    }
  }

  deleteFile(id: number): void {
    const file = this.getFile(id)
    this.db.prepare('DELETE FROM files WHERE id = ?').run(id)
    fs.rmSync(this.filePath(file), { force: true })
  }

  // ---- comparison -------------------------------------------------------------

  compare(experimentId: number): Comparison {
    const runs = this.listRuns(experimentId).map(({ id, seq, title, date, outcome, params }) => ({
      id,
      seq,
      title,
      date,
      outcome,
      params
    }))
    const paramKeys: string[] = []
    for (const r of runs) for (const p of r.params) if (!paramKeys.includes(p.key)) paramKeys.push(p.key)

    const rows = this.db
      .prepare(
        `SELECT res.run_id, res.label, res.unit, avg(res.value) AS value, min(res.id) AS first
         FROM results res JOIN runs r ON r.id = res.run_id
         WHERE r.experiment_id = ?
         GROUP BY res.run_id, res.label, res.unit
         ORDER BY first`
      )
      .all(experimentId) as Row[]
    const metrics: Comparison['metrics'] = []
    const seen = new Set<string>()
    const values: Comparison['values'] = {}
    for (const row of rows) {
      const label = String(row.label)
      const unit = String(row.unit)
      const key = metricKey(label, unit)
      if (!seen.has(key)) {
        seen.add(key)
        metrics.push({ label, unit })
      }
      ;(values[Number(row.run_id)] ??= {})[key] = Number(row.value)
    }
    return { runs, paramKeys, metrics, values }
  }
}

/** First free path for `name` in `dir`: name.ext, name_1.ext, name_2.ext, … */
export function uniquePath(dir: string, name: string): string {
  const ext = path.extname(name)
  const base = name.slice(0, name.length - ext.length)
  let candidate = name
  for (let i = 1; fs.existsSync(path.join(dir, candidate)); i++) candidate = `${base}_${i}${ext}`
  return path.join(dir, candidate)
}

// ---- validation -----------------------------------------------------------------

function cleanExperiment(input: ExperimentInput): ExperimentInput {
  const name = (input.name ?? '').trim()
  if (!name) throw new Error('Experiment name is required')
  if (!EXPERIMENT_STATUSES.includes(input.status)) throw new Error(`Invalid status "${input.status}"`)
  return {
    name,
    subject: (input.subject ?? '').trim(),
    objective: (input.objective ?? '').trim(),
    description: (input.description ?? '').trim(),
    conclusions: (input.conclusions ?? '').trim(),
    status: input.status
  }
}

function cleanRun(input: RunInput): RunInput {
  const date = (input.date ?? '').trim()
  if (!date || Number.isNaN(Date.parse(date))) throw new Error('Run date is required')
  if (!RUN_OUTCOMES.includes(input.outcome)) throw new Error(`Invalid outcome "${input.outcome}"`)
  const params: RunParam[] = []
  for (const p of input.params ?? []) {
    const key = (p.key ?? '').trim()
    const value = (p.value ?? '').trim()
    if (!key && !value) continue
    if (!key) throw new Error(`Parameter with value "${value}" needs a name`)
    if (params.some((q) => q.key === key)) throw new Error(`Parameter "${key}" is listed twice`)
    params.push({ key, value })
  }
  return { title: (input.title ?? '').trim(), date, params, notes: (input.notes ?? '').trim(), outcome: input.outcome }
}

function cleanResult(input: ResultInput): ResultInput {
  const label = (input.label ?? '').trim()
  if (!label) throw new Error('Result label is required')
  const value = Number(input.value)
  if (typeof input.value !== 'number' || !Number.isFinite(value)) throw new Error(`"${label}" needs a numeric value`)
  return { label, value, unit: (input.unit ?? '').trim() }
}

// ---- row mapping ----------------------------------------------------------------

const RUN_SELECT = `SELECT r.*,
  (SELECT count(*) FROM results x WHERE x.run_id = r.id) AS result_count,
  (SELECT count(*) FROM files f WHERE f.run_id = r.id) AS file_count
  FROM runs r`

const toExperiment = (r: Row): Experiment => ({
  id: Number(r.id),
  name: String(r.name),
  subject: String(r.subject),
  objective: String(r.objective),
  description: String(r.description),
  conclusions: String(r.conclusions),
  status: r.status as Experiment['status'],
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
  runCount: Number(r.run_count ?? 0)
})

const toRun = (r: Row): Run => ({
  id: Number(r.id),
  experimentId: Number(r.experiment_id),
  seq: Number(r.seq),
  title: String(r.title),
  date: String(r.date),
  params: [],
  notes: String(r.notes),
  outcome: r.outcome as Run['outcome'],
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
  resultCount: Number(r.result_count ?? 0),
  fileCount: Number(r.file_count ?? 0)
})

const toResult = (r: Row): Result => ({
  id: Number(r.id),
  runId: Number(r.run_id),
  label: String(r.label),
  value: Number(r.value),
  unit: String(r.unit)
})

const toFile = (r: Row): RunFile => ({
  id: Number(r.id),
  runId: Number(r.run_id),
  filename: String(r.filename),
  storedPath: String(r.stored_path),
  sizeBytes: Number(r.size_bytes),
  createdAt: String(r.created_at)
})
