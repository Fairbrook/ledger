import { useCallback, useEffect, useState } from 'react'
import type { Experiment } from '@shared/types'
import { api } from './api'
import ExperimentForm from './components/ExperimentForm'
import ExperimentView from './components/ExperimentView'
import { useUi } from './components/Ui'

export default function App() {
  const ui = useUi()
  const [experiments, setExperiments] = useState<Experiment[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [editing, setEditing] = useState<Experiment | 'new' | null>(null)
  const [filter, setFilter] = useState('')

  const refresh = useCallback(async () => {
    try {
      const list = await api.listExperiments()
      setExperiments(list)
      setSelectedId((cur) => (cur !== null && list.some((e) => e.id === cur) ? cur : (list[0]?.id ?? null)))
    } catch (e) {
      ui.fail(e)
    }
  }, [ui])

  useEffect(() => {
    refresh()
  }, [refresh])

  const selected = experiments.find((e) => e.id === selectedId) ?? null
  const q = filter.trim().toLowerCase()
  const shown = q
    ? experiments.filter((e) => `${e.name} ${e.subject} ${e.objective}`.toLowerCase().includes(q))
    : experiments

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">L</span>
          <span>ledger</span>
        </div>
        <div className="sidebar-section">
          <div className="sidebar-heading">
            <span>Experiments</span>
            <button className="icon-btn" title="New experiment" onClick={() => setEditing('new')}>
              +
            </button>
          </div>
          {experiments.length > 5 && (
            <div className="sidebar-search">
              <input placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
          )}
          <nav className="nav-list">
            {shown.map((e) => (
              <button
                key={e.id}
                className={`nav-item ${e.id === selectedId ? 'active' : ''}`}
                onClick={() => setSelectedId(e.id)}
              >
                <span className="nav-name">{e.name}</span>
                <span className="nav-sub">
                  <span className={`dot ${e.status}`} /> {e.status} · {e.runCount} run{e.runCount === 1 ? '' : 's'}
                  {e.subject && ` · ${e.subject}`}
                </span>
              </button>
            ))}
            {experiments.length === 0 && <p className="muted small pad">No experiments yet.</p>}
            {experiments.length > 0 && shown.length === 0 && <p className="muted small pad">No matches.</p>}
          </nav>
        </div>
      </aside>

      <main className="main">
        {selected ? (
          <ExperimentView
            key={selected.id}
            experiment={selected}
            onEdit={() => setEditing(selected)}
            onChanged={refresh}
          />
        ) : (
          <div className="empty-state">
            <h1>Log your first experiment</h1>
            <p className="muted">
              An experiment is a series of runs against one system, setup or controller. Record what each run tested,
              how it went and the numbers it produced, then compare runs side by side.
            </p>
            <button className="btn primary" onClick={() => setEditing('new')}>
              New experiment
            </button>
          </div>
        )}
      </main>

      {editing && (
        <ExperimentForm
          experiment={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async (e) => {
            setEditing(null)
            await refresh()
            setSelectedId(e.id)
          }}
        />
      )}
    </div>
  )
}
