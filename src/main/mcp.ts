import fs from 'node:fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { EXPERIMENT_STATUSES, RUN_OUTCOMES } from '../shared/types'
import { comparisonToCsv } from './csv'
import type { Ledger } from './ledger'
import {
  analyze,
  findExperiments,
  getExperimentDetail,
  getRunDetail,
  logRun,
  normalizeResult,
  patchExperiment,
  patchRun,
  registerExperiment
} from './service'

const status = z.enum(EXPERIMENT_STATUSES as [string, ...string[]])
const outcome = z.enum(RUN_OUTCOMES as [string, ...string[]])
const params = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
  .describe('What was tested, as { name: value }, e.g. { "Kp": 1.2, "dataset": "hallway_02" }')
const result = z.object({
  label: z.string().describe('Metric name, e.g. "overshoot". Reuse names from earlier runs so they line up.'),
  value: z.number(),
  unit: z.string().optional().describe('e.g. "%", "ms", "m"')
})
const runFields = {
  title: z.string().optional(),
  date: z.string().optional().describe('ISO 8601 date or date-time of the run; defaults to now'),
  notes: z.string().optional().describe('Qualitative observations'),
  outcome: outcome.optional().describe('Defaults to pending')
}
const experimentFields = {
  subject: z.string().optional().describe('The system, setup, controller or algorithm under test'),
  objective: z.string().optional().describe('Question or hypothesis the runs should answer'),
  description: z.string().optional().describe('Setup and method'),
  conclusions: z.string().optional(),
  status: status.optional()
}
const runSpec = z.object({
  ...runFields,
  params: params.optional(),
  results: z.array(result).optional(),
  files: z.array(z.string()).optional().describe('Absolute paths of files to copy into the run')
})

const READ_LIMIT = 200_000

/**
 * MCP server exposing the ledger to an agent such as Claude Code: register experiments and runs,
 * edit them, and pull comparisons, statistics and attached files for analysis.
 */
export function createMcpServer(ledger: Ledger): McpServer {
  const server = new McpServer(
    { name: 'ledger', version: '0.1.0' },
    {
      instructions:
        'ledger is an experiment log. An experiment studies one system through an ordered series of runs; each run ' +
        'records parameters (what was tested), an outcome, notes, numeric results (label, value, unit) and files. ' +
        'Use list_experiments to find ids. Use analyze_experiment and compare_runs to analyse results, and ' +
        'read_run_file to inspect attached logs or CSVs. Reuse existing metric labels and units so runs line up.'
    }
  )

  const tool = <S extends z.ZodRawShape>(
    name: string,
    description: string,
    inputSchema: S,
    fn: (args: z.infer<z.ZodObject<S>>) => unknown,
    annotations: { readOnlyHint?: boolean; destructiveHint?: boolean } = {}
  ) =>
    server.registerTool(name, { description, inputSchema, annotations }, (async (args: any) => {
      try {
        const out = await fn(args)
        const text = typeof out === 'string' ? out : JSON.stringify(out ?? { ok: true }, null, 2)
        return { content: [{ type: 'text' as const, text }] }
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${(err as Error)?.message ?? err}` }], isError: true }
      }
    }) as any)
  const ro = { readOnlyHint: true }
  const destructive = { destructiveHint: true }

  // ---- read & analyse ----

  tool(
    'list_experiments',
    'List experiments (id, name, subject, objective, status, run count), most recently updated first.',
    { query: z.string().optional().describe('Filter on name/subject/objective'), status: status.optional() },
    (a) => findExperiments(ledger, a.query, a.status),
    ro
  )
  tool(
    'get_experiment',
    'An experiment with every run, including parameters, notes, results and file records.',
    { experiment_id: z.number().int() },
    (a) => getExperimentDetail(ledger, a.experiment_id),
    ro
  )
  tool(
    'get_run',
    'One run with its parameters, notes, results and file records.',
    { run_id: z.number().int() },
    (a) => getRunDetail(ledger, a.run_id),
    ro
  )
  tool(
    'compare_runs',
    'Comparison table of an experiment: one row per run, every parameter and metric as a column ' +
      '(per-run mean when a metric was logged more than once).',
    { experiment_id: z.number().int(), format: z.enum(['json', 'csv']).optional().describe('Defaults to csv') },
    (a) => {
      const c = ledger.compare(a.experiment_id)
      return a.format === 'json' ? c : comparisonToCsv(c)
    },
    ro
  )
  tool(
    'analyze_experiment',
    'Statistics for an experiment: outcome counts; per metric n, mean, std, min/max (with run), first/last; and for ' +
      'each parameter that varies, the metric mean per parameter value plus correlation and slope when numeric.',
    { experiment_id: z.number().int() },
    (a) => analyze(ledger, a.experiment_id),
    ro
  )
  tool(
    'read_run_file',
    'Read the contents of a file attached to a run (text files only), e.g. a log or CSV, for analysis.',
    {
      file_id: z.number().int(),
      max_bytes: z.number().int().positive().optional().describe(`Defaults to ${READ_LIMIT}`)
    },
    (a) => {
      const file = ledger.getFile(a.file_id)
      const limit = a.max_bytes ?? READ_LIMIT
      const fd = fs.openSync(ledger.filePath(file), 'r')
      try {
        const buf = Buffer.alloc(Math.min(limit, file.sizeBytes))
        const n = fs.readSync(fd, buf, 0, buf.length, 0)
        const data = buf.subarray(0, n)
        if (data.includes(0)) return `${file.filename} is a binary file (${file.sizeBytes} bytes); not shown.`
        const more = file.sizeBytes > n ? `\n… truncated: showing ${n} of ${file.sizeBytes} bytes` : ''
        return data.toString('utf8') + more
      } finally {
        fs.closeSync(fd)
      }
    },
    ro
  )

  // ---- register & modify ----

  tool(
    'register_experiment',
    'Create an experiment, optionally with its runs (each with params, results and files) in one call. ' +
      'Status defaults to "running" if runs are given, else "planning".',
    { name: z.string(), ...experimentFields, runs: z.array(runSpec).optional() },
    (a) => registerExperiment(ledger, a as any)
  )
  tool(
    'update_experiment',
    'Change an experiment. Only the fields given are updated (e.g. write conclusions, set status to concluded).',
    { experiment_id: z.number().int(), name: z.string().optional(), ...experimentFields },
    ({ experiment_id, ...patch }) => patchExperiment(ledger, experiment_id, patch as any)
  )
  tool(
    'delete_experiment',
    'Permanently delete an experiment with all its runs, results and stored files.',
    { experiment_id: z.number().int() },
    (a) => {
      ledger.getExperiment(a.experiment_id)
      ledger.deleteExperiment(a.experiment_id)
    },
    destructive
  )
  tool(
    'log_run',
    'Add the next run to an experiment, with its parameters, outcome, notes, results and files.',
    { experiment_id: z.number().int(), ...runSpec.shape },
    ({ experiment_id, ...spec }) => logRun(ledger, experiment_id, spec as any)
  )
  tool(
    'update_run',
    'Change a run. Only the fields given are updated. `params` replaces all parameters; `merge_params` sets the ' +
      'given ones and keeps the rest (an empty string removes one).',
    { run_id: z.number().int(), ...runFields, params: params.optional(), merge_params: params.optional() },
    ({ run_id, merge_params, ...patch }) => patchRun(ledger, run_id, { ...(patch as any), mergeParams: merge_params })
  )
  tool(
    'delete_run',
    'Permanently delete a run with its results and stored files. Other runs keep their numbers.',
    { run_id: z.number().int() },
    (a) => ledger.deleteRun(a.run_id),
    destructive
  )
  tool(
    'add_results',
    'Add numeric results to a run (all or nothing).',
    { run_id: z.number().int(), results: z.array(result).min(1) },
    (a) => ledger.addResults(a.run_id, a.results.map((r) => normalizeResult(r as any)))
  )
  tool(
    'update_result',
    'Change one result. Only the fields given are updated.',
    { result_id: z.number().int(), label: z.string().optional(), value: z.number().optional(), unit: z.string().optional() },
    ({ result_id, ...patch }) => {
      const cur = ledger.getResult(result_id)
      return ledger.updateResult(result_id, normalizeResult({ ...cur, ...(patch as any) }))
    }
  )
  tool(
    'delete_result',
    'Delete one result.',
    { result_id: z.number().int() },
    (a) => {
      ledger.getResult(a.result_id)
      ledger.deleteResult(a.result_id)
    },
    destructive
  )
  tool(
    'attach_files',
    'Copy local files (absolute paths) into a run. The originals are left in place.',
    { run_id: z.number().int(), paths: z.array(z.string()).min(1) },
    (a) => ledger.attachFiles(a.run_id, a.paths)
  )
  tool(
    'delete_file',
    'Delete an attached file and its stored copy.',
    { file_id: z.number().int() },
    (a) => ledger.deleteFile(a.file_id),
    destructive
  )

  return server
}
