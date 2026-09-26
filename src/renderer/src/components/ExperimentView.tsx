import { useCallback, useEffect, useState } from 'react'
import type { Experiment, Run } from '@shared/types'
import { api, formatDate, runLabel } from '../api'
import CompareView from './CompareView'
import RunDetail from './RunDetail'
import RunForm, { type RunFormTarget } from './RunForm'
import SummaryView from './SummaryView'
import { useUi } from './Ui'

type Tab = 'runs' | 'compare' | 'summary'

export default function ExperimentView(props: { experiment: Experiment; onEdit: () => void; onChanged: () => void }) {
  const { experiment: exp, onChanged } = props
  const ui = useUi()
  const [runs, setRuns] = useState<Run[]>([])
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null)
  const [runForm, setRunForm] = useState<RunFormTarget | null>(null)
  const [tab, setTab] = useState<Tab>('runs')

  const reloadRuns = useCallback(async () => {
    try {
      const list = await api.listRuns(exp.id)
      setRuns(list)
      setSelectedRunId((cur) =>
        cur !== null && list.some((r) => r.id === cur) ? cur : (list[list.length - 1]?.id ?? null)
      )
    } catch (e) {
      ui.fail(e)
    }
  }, [exp.id, ui])

  useEffect(() => {
    reloadRuns()
  }, [reloadRuns])

  /** Something about a run changed: refresh the list (counts) and the sidebar (run count, ordering). */
  const runsChanged = useCallback(async () => {
    await reloadRuns()
    onChanged()
  }, [reloadRuns, onChanged])

  const deleteExperiment = async () => {
    const ok = await ui.confirm({
      title: 'Delete experiment?',
      message: (
        <p>
          <strong>{exp.name}</strong> and its {exp.runCount} run{exp.runCount === 1 ? '' : 's'}, all their results and
          all attached files will be permanently deleted from disk.
        </p>
      )
    })
    if (!ok) return
    try {
      await api.deleteExperiment(exp.id)
      ui.toast('Experiment deleted')
      onChanged()
    } catch (e) {
      ui.fail(e)
    }
  }

  const selectedRun = runs.find((r) => r.id === selectedRunId) ?? null

  return (
    <div className="view">
      <header className="view-header">
        <div className="view-title">
          <h1>{exp.name}</h1>
          <div className="meta-line">
            <span className={`badge status-${exp.status}`}>{exp.status}</span>
            {exp.subject && (
              <span>
                <span className="muted">System:</span> {exp.subject}
              </span>
            )}
            <span className="muted">Started {formatDate(exp.createdAt)}</span>
          </div>
          {exp.objective && <p className="objective">{exp.objective}</p>}
        </div>
        <div className="header-actions">
          <button className="btn subtle" onClick={props.onEdit}>
            Edit
          </button>
          <button className="btn subtle danger" onClick={deleteExperiment}>
            Delete
          </button>
        </div>
      </header>

      <div className="tabs">
        <button className={tab === 'runs' ? 'active' : ''} onClick={() => setTab('runs')}>
          Runs <span className="count">{runs.length}</span>
        </button>
        <button className={tab === 'compare' ? 'active' : ''} onClick={() => setTab('compare')}>
          Compare
        </button>
        <button className={tab === 'summary' ? 'active' : ''} onClick={() => setTab('summary')}>
          Setup & conclusions
        </button>
      </div>

      {tab === 'runs' && (
        <div className="split">
          <section className="run-list">
            <div className="panel-head">
              <button className="btn primary" onClick={() => setRunForm({ mode: 'new' })}>
                + New run
              </button>
              {selectedRun && (
                <button
                  className="btn"
                  title="Start a new run with the same parameters"
                  onClick={() => setRunForm({ mode: 'new', from: selectedRun })}
                >
                  Repeat {`#${selectedRun.seq}`}
                </button>
              )}
            </div>
            <div className="scroll">
              {runs.map((r) => (
                <button
                  key={r.id}
                  className={`run-item ${r.id === selectedRunId ? 'active' : ''}`}
                  onClick={() => setSelectedRunId(r.id)}
                >
                  <span className="run-top">
                    <span className="run-name">{runLabel(r)}</span>
                    <span className={`badge outcome-${r.outcome}`}>{r.outcome}</span>
                  </span>
                  <span className="run-sub">
                    {formatDate(r.date)} · {r.resultCount} result{r.resultCount === 1 ? '' : 's'}
                    {r.fileCount > 0 && ` · ${r.fileCount} file${r.fileCount === 1 ? '' : 's'}`}
                  </span>
                  {r.params.length > 0 && (
                    <span className="run-params">
                      {r.params.map((p) => `${p.key}=${p.value}`).join('  ')}
                    </span>
                  )}
                </button>
              ))}
              {runs.length === 0 && (
                <div className="empty-inline">
                  <p>No runs yet.</p>
                  <p className="muted small">
                    Each run records the parameters you tried, what you observed and the numbers it produced.
                  </p>
                </div>
              )}
            </div>
          </section>
          <section className="run-pane">
            {selectedRun ? (
              <RunDetail
                key={selectedRun.id}
                run={selectedRun}
                onEdit={() => setRunForm({ mode: 'edit', run: selectedRun })}
                onChanged={runsChanged}
              />
            ) : (
              <div className="empty-inline muted">Select or create a run.</div>
            )}
          </section>
        </div>
      )}
      {tab === 'compare' && <CompareView experimentId={exp.id} onOpenRun={(id) => (setSelectedRunId(id), setTab('runs'))} />}
      {tab === 'summary' && <SummaryView experiment={exp} onSaved={onChanged} />}

      {runForm && (
        <RunForm
          experimentId={exp.id}
          target={runForm}
          onClose={() => setRunForm(null)}
          onSaved={async (r) => {
            setRunForm(null)
            await runsChanged()
            setSelectedRunId(r.id)
          }}
        />
      )}
    </div>
  )
}
