import {
  RUN_OUTCOMES,
  metricKey,
  type Analysis,
  type Experiment,
  type ExperimentDetail,
  type ExperimentInput,
  type MetricStats,
  type ParamEffect,
  type ResultInput,
  type Run,
  type RunInput,
  type RunOutcome,
  type RunWithData
} from '../shared/types'
import type { Ledger } from './ledger'

/**
 * Programmatic operations shared by the local HTTP API and the MCP server. They sit on top of `Ledger`
 * and add what a script or an agent needs but the UI doesn't: defaults, partial updates, and registering
 * an experiment with its runs, results and files in one call.
 */

/** A run to log: any omitted field gets a default (date = now, outcome = pending). */
export interface RunSpec extends Partial<Omit<RunInput, 'params'>> {
  /** Parameters as a list or as a `{ key: value }` object. */
  params?: RunInput['params'] | Record<string, string | number | boolean>
  results?: ResultInput[]
  /** Absolute paths of files to copy into the run's folder. */
  files?: string[]
}

export interface ExperimentSpec extends Partial<ExperimentInput> {
  name: string
  runs?: RunSpec[]
}

// ---- reading ----------------------------------------------------------------------

export function runWithData(ledger: Ledger, run: Run): RunWithData {
  return { ...run, results: ledger.listResults(run.id), files: ledger.listFiles(run.id) }
}

export function getRunDetail(ledger: Ledger, runId: number): RunWithData {
  return runWithData(ledger, ledger.getRun(runId))
}

export function getExperimentDetail(ledger: Ledger, id: number): ExperimentDetail {
  const exp = ledger.getExperiment(id)
  return { ...exp, runs: ledger.listRuns(id).map((r) => runWithData(ledger, r)) }
}

/** Experiments whose name, subject or objective contains `query` (case-insensitive), optionally by status. */
export function findExperiments(ledger: Ledger, query = '', status?: string): Experiment[] {
  const q = query.trim().toLowerCase()
  return ledger
    .listExperiments()
    .filter((e) => !status || e.status === status)
    .filter((e) => !q || `${e.name} ${e.subject} ${e.objective}`.toLowerCase().includes(q))
}

// ---- writing ----------------------------------------------------------------------

/** Creates an experiment and, optionally, its runs. If any part fails, nothing is kept. */
export function registerExperiment(ledger: Ledger, spec: ExperimentSpec): ExperimentDetail {
  const exp = ledger.createExperiment({
    name: spec.name,
    subject: spec.subject ?? '',
    objective: spec.objective ?? '',
    description: spec.description ?? '',
    conclusions: spec.conclusions ?? '',
    status: spec.status ?? (spec.runs?.length ? 'running' : 'planning')
  })
  try {
    for (const run of spec.runs ?? []) logRun(ledger, exp.id, run)
  } catch (err) {
    ledger.deleteExperiment(exp.id)
    throw err
  }
  return getExperimentDetail(ledger, exp.id)
}

/** Updates only the fields given. */
export function patchExperiment(ledger: Ledger, id: number, patch: Partial<ExperimentInput>): Experiment {
  const cur = ledger.getExperiment(id)
  return ledger.updateExperiment(id, {
    name: patch.name ?? cur.name,
    subject: patch.subject ?? cur.subject,
    objective: patch.objective ?? cur.objective,
    description: patch.description ?? cur.description,
    conclusions: patch.conclusions ?? cur.conclusions,
    status: patch.status ?? cur.status
  })
}

/** Adds a run with its results and files. If the results or files fail, the run is removed again. */
export function logRun(ledger: Ledger, experimentId: number, spec: RunSpec): RunWithData {
  const run = ledger.createRun(experimentId, {
    title: spec.title ?? '',
    date: spec.date ?? new Date().toISOString(),
    params: normalizeParams(spec.params),
    notes: spec.notes ?? '',
    outcome: spec.outcome ?? 'pending'
  })
  try {
    if (spec.results?.length) ledger.addResults(run.id, spec.results.map(normalizeResult))
    if (spec.files?.length) ledger.attachFiles(run.id, spec.files)
  } catch (err) {
    ledger.deleteRun(run.id)
    throw err
  }
  return getRunDetail(ledger, run.id)
}

/**
 * Updates only the fields given. `params` replaces the whole list; `mergeParams` instead sets or adds
 * the given keys and keeps the rest (an empty value removes a key).
 */
export function patchRun(
  ledger: Ledger,
  id: number,
  patch: Omit<RunSpec, 'results' | 'files'> & { mergeParams?: RunSpec['params'] }
): RunWithData {
  const cur = ledger.getRun(id)
  let params = patch.params !== undefined ? normalizeParams(patch.params) : cur.params
  if (patch.mergeParams !== undefined) {
    const merged = new Map(params.map((p) => [p.key, p.value]))
    for (const p of normalizeParams(patch.mergeParams)) {
      if (p.value === '') merged.delete(p.key)
      else merged.set(p.key, p.value)
    }
    params = [...merged].map(([key, value]) => ({ key, value }))
  }
  ledger.updateRun(id, {
    title: patch.title ?? cur.title,
    date: patch.date ?? cur.date,
    params,
    notes: patch.notes ?? cur.notes,
    outcome: patch.outcome ?? cur.outcome
  })
  return getRunDetail(ledger, id)
}

export function normalizeParams(params: RunSpec['params']): RunInput['params'] {
  if (!params) return []
  if (Array.isArray(params)) return params.map((p) => ({ key: String(p.key ?? ''), value: String(p.value ?? '') }))
  return Object.entries(params).map(([key, value]) => ({ key, value: String(value) }))
}

/** Accepts numeric strings too ("3.8"), which JSON clients often send. */
export function normalizeResult(r: ResultInput): ResultInput {
  const value = typeof r.value === 'string' && (r.value as string).trim() !== '' ? Number(r.value) : r.value
  return { label: r.label, value, unit: r.unit ?? '' }
}

// ---- analysis ---------------------------------------------------------------------

/** Outcome counts, per-metric statistics, and how each metric moves with each varying parameter. */
export function analyze(ledger: Ledger, experimentId: number): Analysis {
  const exp = ledger.getExperiment(experimentId)
  const c = ledger.compare(experimentId)
  const runs = c.runs // ordered by seq

  const outcomes = Object.fromEntries(RUN_OUTCOMES.map((o) => [o, 0])) as Record<RunOutcome, number>
  for (const r of runs) outcomes[r.outcome]++

  const metrics: MetricStats[] = []
  const paramEffects: ParamEffect[] = []
  for (const m of c.metrics) {
    const key = metricKey(m.label, m.unit)
    const points = runs
      .filter((r) => c.values[r.id]?.[key] !== undefined)
      .map((r) => ({ run: r, value: c.values[r.id][key] }))
    if (points.length === 0) continue
    const vals = points.map((p) => p.value)
    const mean = avg(vals)
    const at = (p: (typeof points)[number]) => ({ value: p.value, runSeq: p.run.seq })
    let lo = points[0]
    let hi = points[0]
    for (const p of points) {
      if (p.value < lo.value) lo = p
      if (p.value > hi.value) hi = p
    }
    metrics.push({
      ...m,
      n: points.length,
      mean,
      std: points.length < 2 ? 0 : Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / (points.length - 1)),
      min: at(lo),
      max: at(hi),
      first: at(points[0]),
      last: at(points[points.length - 1])
    })

    for (const param of c.paramKeys) {
      const pairs = points
        .map((p) => ({ x: p.run.params.find((q) => q.key === param)?.value, y: p.value }))
        .filter((p): p is { x: string; y: number } => p.x !== undefined && p.x !== '')
      const distinct = new Set(pairs.map((p) => p.x))
      if (pairs.length < 2 || distinct.size < 2) continue

      const byValue = new Map<string, number[]>()
      for (const p of pairs) byValue.set(p.x, [...(byValue.get(p.x) ?? []), p.y])
      const groups = [...byValue].map(([value, ys]) => ({ value, n: ys.length, mean: avg(ys) }))

      const effect: ParamEffect = { param, metric: m, groups }
      const xs = pairs.map((p) => Number(p.x))
      if (xs.every(Number.isFinite)) {
        groups.sort((a, b) => Number(a.value) - Number(b.value))
        effect.numeric = { n: pairs.length, ...regression(xs, pairs.map((p) => p.y)) }
      }
      paramEffects.push(effect)
    }
  }

  return {
    experiment: { id: exp.id, name: exp.name, subject: exp.subject, objective: exp.objective, status: exp.status },
    runCount: runs.length,
    outcomes,
    metrics,
    paramEffects
  }
}

const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length

/** Pearson r and least-squares slope; null where undefined (constant x or y). */
function regression(xs: number[], ys: number[]): { correlation: number | null; slope: number | null } {
  const mx = avg(xs)
  const my = avg(ys)
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my)
    sxx += (xs[i] - mx) ** 2
    syy += (ys[i] - my) ** 2
  }
  return {
    slope: sxx === 0 ? null : sxy / sxx,
    correlation: sxx === 0 || syy === 0 ? null : sxy / Math.sqrt(sxx * syy)
  }
}
