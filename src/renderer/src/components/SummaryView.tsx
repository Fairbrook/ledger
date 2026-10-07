import { useEffect, useState } from 'react'
import type { Experiment } from '@shared/types'
import { api } from '../api'
import { useUi } from './Ui'

/** The experiment's qualitative record: setup/method and running conclusions, editable in place. */
export default function SummaryView(props: { experiment: Experiment; onSaved: () => void }) {
  const exp = props.experiment
  const ui = useUi()
  const [description, setDescription] = useState(exp.description)
  const [conclusions, setConclusions] = useState(exp.conclusions)
  const [saving, setSaving] = useState(false)
  const [base, setBase] = useState({ description: exp.description, conclusions: exp.conclusions })
  const dirty = description !== base.description || conclusions !== base.conclusions

  // Saved text changed (here or from the API/MCP): take it, unless the user has unsaved edits.
  useEffect(() => {
    if (exp.description === base.description && exp.conclusions === base.conclusions) return
    if (!dirty) {
      setDescription(exp.description)
      setConclusions(exp.conclusions)
    }
    setBase({ description: exp.description, conclusions: exp.conclusions })
  }, [exp.description, exp.conclusions])

  const save = async () => {
    setSaving(true)
    try {
      await api.updateExperiment(exp.id, { ...exp, description, conclusions })
      ui.toast('Saved')
      props.onSaved()
    } catch (e) {
      ui.fail(e)
    }
    setSaving(false)
  }

  return (
    <div className="summary scroll">
      <label className="field">
        <span>Setup & method</span>
        <textarea
          rows={8}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Hardware, environment, procedure, what stays fixed between runs…"
        />
      </label>
      <label className="field">
        <span>Conclusions</span>
        <textarea
          rows={12}
          value={conclusions}
          onChange={(e) => setConclusions(e.target.value)}
          placeholder="What have the runs shown so far? What worked, what didn't, what to try next."
        />
      </label>
      <div className="modal-actions">
        {dirty && <span className="muted small">Unsaved changes</span>}
        <button className="btn primary" disabled={!dirty || saving} onClick={save}>
          Save
        </button>
      </div>
    </div>
  )
}
