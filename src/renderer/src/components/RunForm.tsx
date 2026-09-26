import { useState } from 'react'
import { RUN_OUTCOMES, type Run, type RunInput, type RunParam } from '@shared/types'
import { api, nowLocal } from '../api'
import Modal from './Modal'
import { useUi } from './Ui'

export type RunFormTarget = { mode: 'new'; from?: Run } | { mode: 'edit'; run: Run }

const toLocalInput = (date: string) => (/^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T00:00` : date.slice(0, 16))

export default function RunForm(props: {
  experimentId: number
  target: RunFormTarget
  onClose: () => void
  onSaved: (r: Run) => void
}) {
  const ui = useUi()
  const { target } = props
  const editing = target.mode === 'edit' ? target.run : null
  const from = target.mode === 'new' ? target.from : undefined
  const [form, setForm] = useState<RunInput>(() =>
    editing
      ? { title: editing.title, date: toLocalInput(editing.date), params: editing.params, notes: editing.notes, outcome: editing.outcome }
      : { title: from?.title ?? '', date: nowLocal(), params: from?.params ?? [], notes: '', outcome: 'pending' }
  )
  const [params, setParams] = useState<RunParam[]>(() => [...form.params, { key: '', value: '' }])
  const [saving, setSaving] = useState(false)
  const set = (patch: Partial<RunInput>) => setForm({ ...form, ...patch })

  const setParam = (i: number, patch: Partial<RunParam>) => {
    const next = params.map((p, j) => (j === i ? { ...p, ...patch } : p))
    // Keep one empty row at the end to type into.
    const last = next[next.length - 1]
    if (last.key || last.value) next.push({ key: '', value: '' })
    setParams(next)
  }
  const removeParam = (i: number) => setParams(params.filter((_, j) => j !== i))

  const keys = params.map((p) => p.key.trim()).filter(Boolean)
  const dupKey = keys.find((k, i) => keys.indexOf(k) !== i)
  const missingKey = params.some((p) => !p.key.trim() && p.value.trim())
  const invalid = !form.date || !!dupKey || missingKey

  const save = async () => {
    if (invalid) return
    setSaving(true)
    const input = { ...form, params: params.filter((p) => p.key.trim() || p.value.trim()) }
    try {
      const saved = editing ? await api.updateRun(editing.id, input) : await api.createRun(props.experimentId, input)
      ui.toast(editing ? `Run #${saved.seq} saved` : `Run #${saved.seq} created`)
      props.onSaved(saved)
    } catch (e) {
      ui.fail(e)
    }
    setSaving(false)
  }

  const title = editing ? `Edit run #${editing.seq}` : from ? `New run (repeating #${from.seq})` : 'New run'

  return (
    <Modal title={title} onClose={props.onClose} wide>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <div className="field-row">
          <label className="field grow">
            <span>Title</span>
            <input
              autoFocus
              value={form.title}
              onChange={(e) => set({ title: e.target.value })}
              placeholder="Short description of what changes in this run (optional)"
            />
          </label>
          <label className="field narrow">
            <span>Date *</span>
            <input type="datetime-local" value={form.date} onChange={(e) => set({ date: e.target.value })} required />
          </label>
          <label className="field narrow">
            <span>Outcome</span>
            <select value={form.outcome} onChange={(e) => set({ outcome: e.target.value as RunInput['outcome'] })}>
              {RUN_OUTCOMES.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          </label>
        </div>

        <h3>What was tested</h3>
        <p className="muted small hint">
          Parameters, configuration or conditions for this run, e.g. <code>Kp = 1.2</code>, <code>dataset = hallway_02</code>.
          They become columns in the comparison table.
        </p>
        <div className="param-grid">
          {params.map((p, i) => (
            <div className="param-row" key={i}>
              <input
                placeholder="parameter"
                value={p.key}
                onChange={(e) => setParam(i, { key: e.target.value })}
                aria-invalid={(!!p.key.trim() && p.key.trim() === dupKey) || (!p.key.trim() && !!p.value.trim())}
              />
              <span className="muted">=</span>
              <input placeholder="value" value={p.value} onChange={(e) => setParam(i, { value: e.target.value })} />
              <button
                type="button"
                className="icon-btn"
                aria-label="Remove parameter"
                disabled={i === params.length - 1}
                onClick={() => removeParam(i)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        {dupKey && <p className="error-text small">Parameter “{dupKey}” is listed twice.</p>}
        {missingKey && <p className="error-text small">Every value needs a parameter name.</p>}

        <h3>Observations</h3>
        <textarea
          rows={6}
          value={form.notes}
          onChange={(e) => set({ notes: e.target.value })}
          placeholder="What happened? Behaviour, anomalies, anything you'd want to know when you look back at this run."
        />

        <div className="modal-actions">
          <button type="button" className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={saving || invalid}>
            {editing ? 'Save' : 'Create run'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
