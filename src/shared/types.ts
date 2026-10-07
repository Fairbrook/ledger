export type ExperimentStatus = 'planning' | 'running' | 'concluded' | 'archived'
export type RunOutcome = 'pending' | 'success' | 'partial' | 'failure' | 'inconclusive'

export const EXPERIMENT_STATUSES: ExperimentStatus[] = ['planning', 'running', 'concluded', 'archived']
export const RUN_OUTCOMES: RunOutcome[] = ['pending', 'success', 'partial', 'failure', 'inconclusive']

/** A study of one system/setup/controller, made of an ordered series of runs. */
export interface Experiment {
  id: number
  name: string
  /** What is being tested: the system, setup, controller, algorithm… */
  subject: string
  /** Question or hypothesis the runs are meant to answer. */
  objective: string
  description: string
  /** Qualitative summary written as the experiment progresses / once it ends. */
  conclusions: string
  status: ExperimentStatus
  createdAt: string
  updatedAt: string
  runCount: number
}

export interface ExperimentInput {
  name: string
  subject: string
  objective: string
  description: string
  conclusions: string
  status: ExperimentStatus
}

/** One configuration value a run was executed with (e.g. Kp = 1.2, dataset = hallway_02). */
export interface RunParam {
  key: string
  value: string
}

/** One trial of an experiment: what was tested, how it went, and what came out of it. */
export interface Run {
  id: number
  experimentId: number
  /** Position within the experiment (#1, #2, …), assigned on creation. */
  seq: number
  title: string
  /** ISO 8601 date or date-time when the run took place. */
  date: string
  params: RunParam[]
  /** Qualitative observations. */
  notes: string
  outcome: RunOutcome
  createdAt: string
  updatedAt: string
  resultCount: number
  fileCount: number
}

export interface RunInput {
  title: string
  date: string
  params: RunParam[]
  notes: string
  outcome: RunOutcome
}

/** A single quantitative data point captured during a run. */
export interface Result {
  id: number
  runId: number
  label: string
  value: number
  unit: string
}

export interface ResultInput {
  label: string
  value: number
  unit: string
}

/** A file produced by a run, copied into the managed storage folder. */
export interface RunFile {
  id: number
  runId: number
  filename: string
  /** Path relative to the storage root: <experimentId>/<runId>/<name>. */
  storedPath: string
  sizeBytes: number
  createdAt: string
}

/** Runs × (parameters, metrics) matrix for comparing the runs of one experiment. */
export interface Comparison {
  runs: Pick<Run, 'id' | 'seq' | 'title' | 'date' | 'outcome' | 'params'>[]
  paramKeys: string[]
  metrics: { label: string; unit: string }[]
  /** values[runId][metricKey(label, unit)] — the mean if a run logged the metric more than once. */
  values: Record<number, Record<string, number>>
}

export const metricKey = (label: string, unit: string) => `${label}\u0000${unit}`

/** A run with its results and attached files, as returned by the local API and MCP server. */
export interface RunWithData extends Run {
  results: Result[]
  files: RunFile[]
}

/** An experiment with every run, result and file record. */
export interface ExperimentDetail extends Experiment {
  runs: RunWithData[]
}

/** Summary statistics of one metric across the runs that logged it (per-run means, see Comparison). */
export interface MetricStats {
  label: string
  unit: string
  /** Number of runs with a value. */
  n: number
  mean: number
  /** Sample standard deviation (0 when n < 2). */
  std: number
  min: { value: number; runSeq: number }
  max: { value: number; runSeq: number }
  /** Value in the first and last run (by seq) that logged it. */
  first: { value: number; runSeq: number }
  last: { value: number; runSeq: number }
}

/** How a metric moves with a parameter that varies between runs. */
export interface ParamEffect {
  param: string
  metric: { label: string; unit: string }
  /** Numeric parameter: Pearson correlation and least-squares slope (metric per unit of param). */
  numeric?: { n: number; correlation: number | null; slope: number | null }
  /** Mean of the metric for each value of the parameter. */
  groups: { value: string; n: number; mean: number }[]
}

export interface Analysis {
  experiment: Pick<Experiment, 'id' | 'name' | 'subject' | 'objective' | 'status'>
  runCount: number
  outcomes: Record<RunOutcome, number>
  metrics: MetricStats[]
  /** One entry per (varying parameter, metric) pair with values in at least two runs. */
  paramEffects: ParamEffect[]
}

export interface AppInfo {
  dataDir: string
  filesRoot: string
  dbFile: string
  /** Base URL of the local HTTP API, or null when it is disabled or failed to start. */
  apiUrl?: string | null
}

/** API exposed to the renderer by the preload script (window.ledger). */
export interface LedgerApi {
  info(): Promise<AppInfo>

  listExperiments(): Promise<Experiment[]>
  createExperiment(input: ExperimentInput): Promise<Experiment>
  updateExperiment(id: number, input: ExperimentInput): Promise<Experiment>
  deleteExperiment(id: number): Promise<void>
  compareRuns(experimentId: number): Promise<Comparison>
  exportComparisonCsv(experimentId: number): Promise<string | null>

  listRuns(experimentId: number): Promise<Run[]>
  createRun(experimentId: number, input: RunInput): Promise<Run>
  updateRun(id: number, input: RunInput): Promise<Run>
  deleteRun(id: number): Promise<void>

  listResults(runId: number): Promise<Result[]>
  addResults(runId: number, inputs: ResultInput[]): Promise<Result[]>
  updateResult(id: number, input: ResultInput): Promise<Result>
  deleteResult(id: number): Promise<void>

  listFiles(runId: number): Promise<RunFile[]>
  /** Opens a native file picker and attaches the chosen files. Returns the files added. */
  attachFiles(runId: number): Promise<RunFile[]>
  openFile(id: number): Promise<void>
  revealFile(id: number): Promise<void>
  deleteFile(id: number): Promise<void>

  /** Subscribes to changes made outside the window (local API, MCP server). Returns an unsubscribe function. */
  onExternalChange(cb: () => void): () => void
}
