import { useCallback, useEffect, useState } from 'react'
import type { Result, Run, RunFile } from '@shared/types'
import { api, formatDate, runLabel } from '../api'
import FileList from './FileList'
import ResultsTable from './ResultsTable'
import { useUi } from './Ui'

export default function RunDetail(props: { run: Run; onEdit: () => void; onChanged: () => void }) {
  const { run, onChanged } = props
  const ui = useUi()
  const [results, setResults] = useState<Result[]>([])
  const [files, setFiles] = useState<RunFile[]>([])
  const [knownMetrics, setKnownMetrics] = useState<{ label: string; unit: string }[]>([])

  const reload = useCallback(async () => {
    try {
      const [res, fs, cmp] = await Promise.all([
        api.listResults(run.id),
        api.listFiles(run.id),
        api.compareRuns(run.experimentId)
      ])
      setResults(res)
      setFiles(fs)
      setKnownMetrics(cmp.metrics)
    } catch (e) {
      ui.fail(e)
    }
  }, [run.id, run.experimentId, ui])

  useEffect(() => {
    reload()
  }, [reload])

  const changed = useCallback(async () => {
    await reload()
    onChanged()
  }, [reload, onChanged])

  const deleteRun = async () => {
    const ok = await ui.confirm({
      title: `Delete run #${run.seq}?`,
      message: (
        <p>
          The run, its {results.length} result{results.length === 1 ? '' : 's'} and {files.length} attached file
          {files.length === 1 ? '' : 's'} will be permanently deleted from disk. Other runs keep their numbers.
        </p>
      )
    })
    if (!ok) return
    try {
      await api.deleteRun(run.id)
      ui.toast(`Run #${run.seq} deleted`)
      onChanged()
    } catch (e) {
      ui.fail(e)
    }
  }

  return (
    <div className="run-detail">
      <header className="run-header">
        <div>
          <h2>{runLabel(run)}</h2>
          <div className="meta-line">
            <span className={`badge outcome-${run.outcome}`}>{run.outcome}</span>
            <span className="muted">{formatDate(run.date)}</span>
          </div>
        </div>
        <div className="header-actions">
          <button className="btn subtle" onClick={props.onEdit}>
            Edit
          </button>
          <button className="btn subtle danger" onClick={deleteRun}>
            Delete
          </button>
        </div>
      </header>

      <section className="block">
        <h3>What was tested</h3>
        {run.params.length > 0 ? (
          <div className="chips">
            {run.params.map((p) => (
              <span key={p.key} className="chip param">
                <span className="muted">{p.key}</span> {p.value}
              </span>
            ))}
          </div>
        ) : (
          <p className="muted small">No parameters recorded.</p>
        )}
      </section>

      <section className="block">
        <h3>Observations</h3>
        {run.notes ? <p className="notes">{run.notes}</p> : <p className="muted small">No observations yet.</p>}
      </section>

      <ResultsTable runId={run.id} results={results} knownMetrics={knownMetrics} onChanged={changed} />
      <FileList runId={run.id} files={files} onChanged={changed} />
    </div>
  )
}
