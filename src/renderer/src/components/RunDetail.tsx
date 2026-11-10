import { useCallback, useEffect, useState } from 'react'
import type { ArchiveProgress, RemoteStatus, Result, Run, RunFile } from '@shared/types'
import { api, cleanError, formatBytes, formatDate, runLabel, useDataVersion } from '../api'
import FileList from './FileList'
import { ArchivedPill, IconButton } from './Icons'
import ResultsTable from './ResultsTable'
import { useUi } from './Ui'

const formatEta = (seconds: number) => {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`
  const m = Math.round(seconds / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`
}

/** Label and bar value (0–1, or null when unknown) for a transfer in flight. */
function describeTransfer(p: ArchiveProgress): { label: string; value: number | null } {
  const eta = p.eta != null ? ` · ${formatEta(p.eta)} left` : ''
  const files = p.total > 0 ? ` · ${p.done} / ${p.total} file${p.total === 1 ? '' : 's'}` : ''
  const bytes = p.totalBytes > 0 ? `${formatBytes(p.bytes)} / ${formatBytes(p.totalBytes)}` : formatBytes(p.bytes)
  const byBytes = p.totalBytes > 0 ? Math.min(1, p.bytes / p.totalBytes) : null
  switch (p.phase) {
    case 'uploading':
      return { label: `Uploading ${bytes}${files}${eta}`, value: byBytes }
    case 'downloading':
      return { label: `Downloading ${bytes}${files}${eta}`, value: byBytes }
    case 'verifying':
      // Hash checks only count files; a content comparison also moves bytes.
      if (p.bytes > 0) return { label: `Verifying ${bytes}${files}${eta}`, value: byBytes }
      return {
        label: p.total > 0 ? `Verifying ${p.done} / ${p.total} file${p.total === 1 ? '' : 's'}` : 'Verifying the remote copy…',
        value: p.total > 0 ? p.done / p.total : null
      }
    case 'removing':
      return { label: 'Removing local files…', value: null }
  }
}

export default function RunDetail(props: { run: Run; onEdit: () => void; onChanged: () => void }) {
  const { run, onChanged } = props
  const ui = useUi()
  const [results, setResults] = useState<Result[]>([])
  const [files, setFiles] = useState<RunFile[]>([])
  const [knownMetrics, setKnownMetrics] = useState<{ label: string; unit: string }[]>([])
  const [remote, setRemote] = useState<RemoteStatus | null>(null)
  const [working, setWorking] = useState(false)
  const [transfer, setTransfer] = useState<ArchiveProgress | null>(null)
  const dataVersion = useDataVersion()

  const reload = useCallback(async () => {
    try {
      const [res, fs, cmp, rem, active] = await Promise.all([
        api.listResults(run.id),
        api.listFiles(run.id),
        api.compareRuns(run.experimentId),
        api.remoteStatus(),
        api.activeTransfers()
      ])
      setResults(res)
      setFiles(fs)
      setKnownMetrics(cmp.metrics)
      setRemote(rem)
      // Also picks up an archive that started before this window loaded, and clears one that has finished.
      setTransfer(active.find((p) => p.runId === run.id) ?? null)
    } catch (e) {
      ui.fail(e)
    }
  }, [run.id, run.experimentId, ui, dataVersion])

  useEffect(() => {
    reload()
  }, [reload])

  useEffect(() => api.onRemoteProgress((p) => p.runId === run.id && setTransfer(p)), [run.id])

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
      if (cleanError(e) === 'Cancelled') ui.toast('Archive cancelled; files kept locally')
      else ui.fail(e)
    }
    setTransfer(null)
    setWorking(false)
  }

  const restore = async () => {
    setWorking(true)
    try {
      await api.restoreRun(run.id)
      ui.toast(`Run #${run.seq} restored`)
      await changed()
    } catch (e) {
      if (cleanError(e) === 'Cancelled') ui.toast('Restore cancelled')
      else ui.fail(e)
    }
    setTransfer(null)
    setWorking(false)
  }

  const busy = working || transfer !== null
  const progress = transfer && describeTransfer(transfer)

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
            {run.archivedAt && <ArchivedPill title={`Archived ${formatDate(run.archivedAt)}`} />}
            <span className="muted">{formatDate(run.date)}</span>
          </div>
        </div>
        <div className="header-actions">
          {run.archivedAt ? (
            <IconButton
              icon="restore"
              label={busy ? 'Restoring…' : 'Restore files'}
              onClick={restore}
              disabled={busy || !remote?.configured}
            />
          ) : (
            files.length > 0 &&
            remote?.configured && (
              <IconButton icon="archive" label={busy ? 'Archiving…' : 'Archive run'} onClick={archive} disabled={busy} />
            )
          )}
          <IconButton icon="edit" label="Edit run" onClick={props.onEdit} />
          <IconButton icon="trash" label="Delete run" danger onClick={deleteRun} />
        </div>
      </header>

      {busy && (
        <div className="transfer-progress" role="status">
          <div className="transfer-line">
            <span>{progress?.label ?? 'Starting…'}</span>
            {transfer && transfer.phase !== 'removing' && (
              <button className="btn subtle small" onClick={() => api.cancelArchive(run.id)}>
                Cancel
              </button>
            )}
          </div>
          <progress max={1} value={progress?.value ?? undefined} />
        </div>
      )}

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
