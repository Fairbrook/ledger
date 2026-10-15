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
  /** When the run's local files were removed (they live on the remote only); null while they are local. */
  archivedAt: string | null
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
  /** Path relative to the run's folder, '/'-separated; may include subfolders (plots/fig.png). */
  filename: string
  /** Path relative to the storage root: <experimentId>/<runId>/<filename> (last segment numbered on clashes). */
  storedPath: string
  sizeBytes: number
  createdAt: string
  /** When the file was confirmed uploaded to the remote; null while only local. */
  backedUpAt: string | null
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

export interface RemoteSettings {
  /** rclone remote path, e.g. "gdrive:ledger" or a local directory. */
  remote: string
  /** rclone executable; empty means "rclone" from PATH. */
  rcloneBin: string
}

export interface RemoteStatus {
  configured: boolean
  remote: string | null
  /** Where the active configuration comes from: env vars win over the settings dialog. */
  source: 'env' | 'settings' | null
  /** Files waiting to be uploaded. */
  pending: number
  lastError: string | null
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
  /** Uploads what is missing, verifies the remote copy, then deletes the run's local files. */
  archiveRun(id: number): Promise<Run>
  /** Downloads an archived run's files back from the remote. */
  restoreRun(id: number): Promise<Run>

  getRemoteSettings(): Promise<RemoteSettings & { source: RemoteStatus['source'] }>
  saveRemoteSettings(input: RemoteSettings): Promise<void>
  /** Runs `rclone version` and a listing of the remote; returns a short description or throws. */
  testRemote(): Promise<string>
  remoteStatus(): Promise<RemoteStatus>
  /** Starts uploading pending files now instead of waiting for the next tick. */
  backupNow(): Promise<void>

  listResults(runId: number): Promise<Result[]>
  addResults(runId: number, inputs: ResultInput[]): Promise<Result[]>
  updateResult(id: number, input: ResultInput): Promise<Result>
  deleteResult(id: number): Promise<void>

  listFiles(runId: number): Promise<RunFile[]>
  /**
   * Opens a native picker (files, or folders with `folder`) and attaches the choice, optionally into a
   * subfolder of the run. Returns the files added.
   */
  attachFiles(runId: number, opts?: { folder?: boolean; into?: string }): Promise<RunFile[]>
  openFile(id: number): Promise<void>
  revealFile(id: number): Promise<void>
  deleteFile(id: number): Promise<void>

  /** Subscribes to changes made outside the window (local API, MCP server). Returns an unsubscribe function. */
  onExternalChange(cb: () => void): () => void
}
