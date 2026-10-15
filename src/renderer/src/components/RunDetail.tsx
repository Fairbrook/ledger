import { useCallback, useEffect, useState } from 'react'
import type { RemoteStatus, Result, Run, RunFile } from '@shared/types'
import { api, formatDate, runLabel, useDataVersion } from '../api'
import FileList from './FileList'
import ResultsTable from './ResultsTable'
import { useUi } from './Ui'

export default function RunDetail(props: { run: Run; onEdit: () => void; onChanged: () => void }) {
  const { run, onChanged } = props
  const ui = useUi()
  const [results, setResults] = useState<Result[]>([])
  const [files, setFiles] = useState<RunFile[]>([])
  const [knownMetrics, setKnownMetrics] = useState<{ label: string; unit: string }[]>([])
  const [remote, setRemote] = useState<RemoteStatus | null>(null)
  const [working, setWorking] = useState(false)
  const dataVersion = useDataVersion()

  const reload = useCallback(async () => {
    try {
      const [res, fs, cmp, rem] = await Promise.all([
        api.listResults(run.id),
        api.listFiles(run.id),
        api.compareRuns(run.experimentId),
        api.remoteStatus()
      ])
      setResults(res)
      setFiles(fs)
      setKnownMetrics(cmp.metrics)
      setRemote(rem)
    } catch (e) {
      ui.fail(e)
    }
  }, [run.id, run.experimentId, ui, dataVersion])

  useEffect(() => {
    reload()
  }, [reload])

  const changed = useCallback(async () => {
    await reload()
    onChanged()
  }, [reload, onChanged])

  const archive = async () => {
    const ok = await ui.confirm({
      title: `Archive run #${run.seq}?`,
      confirmLabel: 'Archive',
      message: (
        <p>
          {files.length} file{files.length === 1 ? '' : 's'} will be uploaded to <strong>{remote?.remote}</strong>,
          verified, and then deleted from this computer. The run, its results and notes stay; you can restore the files
          later.
        </p>
      )
    })
    if (!ok) return
    setWorking(true)
    try {
      await api.archiveRun(run.id)
      ui.toast(`Run #${run.seq} archived`)
      await changed()
    } catch (e) {
      ui.fail(e)
    }
    setWorking(false)
  }

  const restore = async () => {
    setWorking(true)
    try {
      await api.restoreRun(run.id)
      ui.toast(`Run #${run.seq} restored`)
      await changed()
    } catch (e) {
      ui.fail(e)
    }
    setWorking(false)
  }

  const deleteRun = async () => {
    const ok = await ui.confirm({
      title: `Delete run #${run.seq}?`,
      message: (
        <p>
          The run, its {results.length} result{results.length === 1 ? '' : 's'} and {files.length} attached file
          {files.length === 1 ? '' : 's'} will be permanently deleted from disk
          {remote?.configured ? ' and from the remote' : ''}. Other runs keep their numbers.
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
            {run.archivedAt && (
              <span className="badge archived" title={`Archived ${formatDate(run.archivedAt)}`}>
                archived
              </span>
            )}
            <span className="muted">{formatDate(run.date)}</span>
          </div>
        </div>
        <div className="header-actions">
          {run.archivedAt ? (
            <button className="btn subtle" onClick={restore} disabled={working || !remote?.configured}>
              {working ? 'Restoring…' : 'Restore files'}
            </button>
          ) : (
            files.length > 0 &&
            remote?.configured && (
              <button className="btn subtle" onClick={archive} disabled={working}>
                {working ? 'Archiving…' : 'Archive'}
              </button>
            )
          )}
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
      <FileList runId={run.id} files={files} archived={!!run.archivedAt} onChanged={changed} />
    </div>
  )
}
