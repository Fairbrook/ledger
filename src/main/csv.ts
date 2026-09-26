import { metricKey, type Comparison } from '../shared/types'

const cell = (v: string | number) => {
  const s = String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** One row per run: identity, outcome, every parameter, then every metric (header carries the unit). */
export function comparisonToCsv(c: Comparison): string {
  const header = [
    'run',
    'title',
    'date',
    'outcome',
    ...c.paramKeys,
    ...c.metrics.map((m) => (m.unit ? `${m.label} [${m.unit}]` : m.label))
  ]
  const rows = c.runs.map((r) => [
    r.seq,
    r.title,
    r.date,
    r.outcome,
    ...c.paramKeys.map((k) => r.params.find((p) => p.key === k)?.value ?? ''),
    ...c.metrics.map((m) => c.values[r.id]?.[metricKey(m.label, m.unit)] ?? '')
  ])
  return [header, ...rows].map((row) => row.map(cell).join(',')).join('\n') + '\n'
}
