import { useState } from 'react'
import { EXPERIMENT_STATUSES, type Experiment, type ExperimentInput } from '@shared/types'
import { api } from '../api'
import Modal from './Modal'
import { useUi } from './Ui'

export default function ExperimentForm(props: {
  experiment: Experiment | null
  onClose: () => void
  onSaved: (e: Experiment) => void
}) {
  const ui = useUi()
  const e = props.experiment
  const [form, setForm] = useState<ExperimentInput>({
    name: e?.name ?? '',
    subject: e?.subject ?? '',
    objective: e?.objective ?? '',
    description: e?.description ?? '',
    conclusions: e?.conclusions ?? '',
    status: e?.status ?? 'planning'
  })
  const [touched, setTouched] = useState(false)
  const [saving, setSaving] = useState(false)
  const set = (patch: Partial<ExperimentInput>) => setForm({ ...form, ...patch })
  const nameMissing = !form.name.trim()

  const save = async () => {
    setTouched(true)
    if (nameMissing) return
    setSaving(true)
    try {
      const saved = e ? await api.updateExperiment(e.id, form) : await api.createExperiment(form)
      ui.toast(e ? 'Experiment saved' : 'Experiment created')
      props.onSaved(saved)
    } catch (err) {
      ui.fail(err)
    }
    setSaving(false)
  }

  return (
    <Modal title={e ? 'Edit experiment' : 'New experiment'} onClose={props.onClose} wide>
      <form
        onSubmit={(ev) => {
          ev.preventDefault()
          save()
        }}
      >
        <div className="field-row">
          <label className="field grow">
            <span>Name *</span>
            <input
              autoFocus
              value={form.name}
              onChange={(ev) => set({ name: ev.target.value })}
              placeholder="e.g. Altitude PID tuning"
              aria-invalid={touched && nameMissing}
            />
            {touched && nameMissing && <small className="error-text">A name is required.</small>}
          </label>
          <label className="field narrow">
            <span>Status</span>
            <select value={form.status} onChange={(ev) => set({ status: ev.target.value as ExperimentInput['status'] })}>
              {EXPERIMENT_STATUSES.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
        </div>
        <label className="field">
          <span>System under test</span>
          <input
            value={form.subject}
            onChange={(ev) => set({ subject: ev.target.value })}
            placeholder="The system, setup, controller or algorithm being analysed"
          />
        </label>
        <label className="field">
          <span>Objective / hypothesis</span>
          <textarea
            rows={2}
            value={form.objective}
            onChange={(ev) => set({ objective: ev.target.value })}
            placeholder="What should these runs tell you?"
          />
        </label>
        <label className="field">
          <span>Setup & method</span>
          <textarea
            rows={4}
            value={form.description}
            onChange={(ev) => set({ description: ev.target.value })}
            placeholder="Hardware, environment, procedure, what stays fixed between runs…"
          />
        </label>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={saving}>
            {e ? 'Save' : 'Create experiment'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
