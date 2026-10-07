import { useEffect, useState } from 'react'
import { metricKey, type Comparison } from '@shared/types'
import { api, formatDate, formatNumber, useDataVersion } from '../api'
import { useUi } from './Ui'

/** Every run as a row; parameters and metrics as columns, with the best/worst value per metric marked. */
export default function CompareView(props: { experimentId: number; onOpenRun: (runId: number) => void }) {
  const ui = useUi()
  const [c, setC] = useState<Comparison | null>(null)
  const dataVersion = useDataVersion()

  useEffect(() => {
    api.compareRuns(props.experimentId).then(setC, ui.fail)
  }, [props.experimentId, ui, dataVersion])

  if (!c) return null
  if (c.runs.length === 0)
    return <div className="empty-inline muted">Add runs to compare them here.</div>

  const exportCsv = async () => {
    try {
      const file = await api.exportComparisonCsv(props.experimentId)
      if (file) ui.toast(`Exported to ${file}`)
    } catch (e) {
      ui.fail(e)
    }
  }

  const ranges = Object.fromEntries(
    c.metrics.map((m) => {
      const key = metricKey(m.label, m.unit)
      const vals = c.runs.map((r) => c.values[r.id]?.[key]).filter((v): v is number => v !== undefined)
      return [key, { min: Math.min(...vals), max: Math.max(...vals), n: vals.length }]
    })
  )

  return (
    <div className="compare">
      <div className="panel-head">
        <span className="muted small">
          {c.runs.length} runs · {c.paramKeys.length} parameters · {c.metrics.length} metrics. Metrics logged more than
          once in a run show their mean. Highest ▲ and lowest ▼ values are marked.
        </span>
        <span className="spacer" />
        <button className="btn" onClick={exportCsv}>
          Export CSV
        </button>
      </div>
      <div className="scroll">
        <table className="table compare-table">
          <thead>
            <tr>
              <th>Run</th>
              <th>Date</th>
              <th>Outcome</th>
              {c.paramKeys.map((k) => (
                <th key={`p-${k}`} className="param-col">
                  {k}
                </th>
              ))}
              {c.metrics.map((m) => (
                <th key={metricKey(m.label, m.unit)} className="num metric-col">
                  {m.label}
                  {m.unit && <span className="muted"> [{m.unit}]</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {c.runs.map((r) => (
              <tr key={r.id}>
                <td>
                  <button className="link" onClick={() => props.onOpenRun(r.id)}>
                    #{r.seq}
                  </button>{' '}
                  {r.title}
                </td>
                <td className="muted nowrap">{formatDate(r.date)}</td>
                <td>
                  <span className={`badge outcome-${r.outcome}`}>{r.outcome}</span>
                </td>
                {c.paramKeys.map((k) => (
                  <td key={`p-${k}`} className="param-col">
                    {r.params.find((p) => p.key === k)?.value ?? <span className="muted">—</span>}
                  </td>
                ))}
                {c.metrics.map((m) => {
                  const key = metricKey(m.label, m.unit)
                  const v = c.values[r.id]?.[key]
                  const range = ranges[key]
                  const mark = v === undefined || range.n < 2 || range.min === range.max ? '' : v === range.max ? 'max' : v === range.min ? 'min' : ''
                  return (
                    <td key={key} className={`num ${mark}`}>
                      {v === undefined ? <span className="muted">—</span> : formatNumber(v)}
                      {mark === 'max' && ' ▲'}
                      {mark === 'min' && ' ▼'}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
