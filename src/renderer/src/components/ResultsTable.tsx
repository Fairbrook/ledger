import { useRef, useState, type KeyboardEvent } from 'react'
import type { Result, ResultInput } from '@shared/types'
import { api, formatNumber } from '../api'
import { useUi } from './Ui'

interface Draft {
  label: string
  value: string
  unit: string
}

const emptyDraft: Draft = { label: '', value: '', unit: '' }

/** Parse a draft row; returns an error message or the input. */
function parse(d: Draft): ResultInput | string {
  if (!d.label.trim()) return 'A label is required'
  const n = Number(d.value.trim().replace(',', '.'))
  if (!d.value.trim() || !Number.isFinite(n)) return `“${d.label.trim()}” needs a numeric value`
  return { label: d.label.trim(), value: n, unit: d.unit.trim() }
}

/** Parse pasted "label, value, unit" / tab-separated lines. */
function parseBulk(text: string): ResultInput[] | string {
  const out: ResultInput[] = []
  for (const [i, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue
    const cols = line.includes('\t') ? line.split('\t') : line.split(/[,;]/)
    const r = parse({ label: cols[0] ?? '', value: cols[1] ?? '', unit: cols[2] ?? '' })
    if (typeof r === 'string') return `Line ${i + 1}: ${r}`
    out.push(r)
  }
  return out.length ? out : 'Nothing to add'
}

export default function ResultsTable(props: {
  runId: number
  results: Result[]
  knownMetrics: { label: string; unit: string }[]
  onChanged: () => void
}) {
  const ui = useUi()
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const [draftError, setDraftError] = useState('')
  const [editing, setEditing] = useState<{ id: number; draft: Draft } | null>(null)
  const [bulk, setBulk] = useState<string | null>(null)
  const labelRef = useRef<HTMLInputElement>(null)

  const labels = [...new Set(props.knownMetrics.map((m) => m.label))]

  const add = async () => {
    const r = parse(draft)
    if (typeof r === 'string') return setDraftError(r)
    try {
      await api.addResults(props.runId, [r])
      setDraft(emptyDraft)
      setDraftError('')
      labelRef.current?.focus()
      props.onChanged()
    } catch (e) {
      ui.fail(e)
    }
  }

  const addBulk = async () => {
    const r = parseBulk(bulk ?? '')
    if (typeof r === 'string') return ui.toast(r, 'error')
    try {
      await api.addResults(props.runId, r)
      ui.toast(`${r.length} result${r.length === 1 ? '' : 's'} added`)
      setBulk(null)
      props.onChanged()
    } catch (e) {
      ui.fail(e)
    }
  }

  const saveEdit = async () => {
    if (!editing) return
    const r = parse(editing.draft)
    if (typeof r === 'string') return ui.toast(r, 'error')
    try {
      await api.updateResult(editing.id, r)
      setEditing(null)
      props.onChanged()
    } catch (e) {
      ui.fail(e)
    }
  }

  const remove = async (res: Result) => {
    const ok = await ui.confirm({ title: 'Delete result?', message: <p>Delete “{res.label}” = {formatNumber(res.value)} {res.unit}?</p> })
    if (!ok) return
    try {
      await api.deleteResult(res.id)
      props.onChanged()
    } catch (e) {
      ui.fail(e)
    }
  }

  // Suggest the unit last used with a label so metrics line up across runs.
  const pickLabel = (label: string) => {
    const known = props.knownMetrics.find((m) => m.label === label)
    setDraft({ ...draft, label, unit: draft.unit || known?.unit || '' })
  }

  const n = props.results.length
  const onKey = (e: KeyboardEvent, fn: () => void) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      fn()
    }
  }

  return (
    <section className="block">
      <div className="block-head">
        <h3>Results</h3>
        <span className="muted small">
          {n} result{n === 1 ? '' : 's'} recorded
        </span>
        <span className="spacer" />
        <button className="link" onClick={() => setBulk(bulk === null ? '' : null)}>
          {bulk === null ? 'Paste several…' : 'Cancel paste'}
        </button>
      </div>

      {bulk !== null && (
        <div className="bulk">
          <textarea
            rows={5}
            autoFocus
            value={bulk}
            onChange={(e) => setBulk(e.target.value)}
            placeholder={'One result per line: label, value, unit\novershoot, 4.2, %\nrise time, 0.83, s'}
          />
          <div className="modal-actions">
            <button className="btn primary" onClick={addBulk}>
              Add all
            </button>
          </div>
        </div>
      )}

      <table className="table">
        <thead>
          <tr>
            <th>Metric</th>
            <th className="num">Value</th>
            <th>Unit</th>
            <th className="actions" />
          </tr>
        </thead>
        <tbody>
          {props.results.map((r) =>
            editing?.id === r.id ? (
              <tr key={r.id} className="editing">
                <td>
                  <input
                    autoFocus
                    value={editing.draft.label}
                    onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, label: e.target.value } })}
                    onKeyDown={(e) => onKey(e, saveEdit)}
                  />
                </td>
                <td>
                  <input
                    className="num"
                    inputMode="decimal"
                    value={editing.draft.value}
                    onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, value: e.target.value } })}
                    onKeyDown={(e) => onKey(e, saveEdit)}
                  />
                </td>
                <td>
                  <input
                    value={editing.draft.unit}
                    onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, unit: e.target.value } })}
                    onKeyDown={(e) => onKey(e, saveEdit)}
                  />
                </td>
                <td className="actions">
                  <button className="btn small primary" onClick={saveEdit}>
                    Save
                  </button>
                  <button className="btn small subtle" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                </td>
              </tr>
            ) : (
              <tr key={r.id} onDoubleClick={() => setEditing({ id: r.id, draft: { label: r.label, value: String(r.value), unit: r.unit } })}>
                <td>{r.label}</td>
                <td className="num">{formatNumber(r.value)}</td>
                <td className="muted">{r.unit}</td>
                <td className="actions">
                  <button
                    className="btn small subtle"
                    onClick={() => setEditing({ id: r.id, draft: { label: r.label, value: String(r.value), unit: r.unit } })}
                  >
                    Edit
                  </button>
                  <button className="btn small subtle danger" onClick={() => remove(r)}>
                    Delete
                  </button>
                </td>
              </tr>
            )
          )}
          <tr className="add-row">
            <td>
              <input
                ref={labelRef}
                list={`metrics-${props.runId}`}
                placeholder="metric, e.g. overshoot"
                value={draft.label}
                onChange={(e) => pickLabel(e.target.value)}
                onKeyDown={(e) => onKey(e, add)}
              />
              <datalist id={`metrics-${props.runId}`}>
                {labels.map((l) => (
                  <option key={l} value={l} />
                ))}
              </datalist>
            </td>
            <td>
              <input
                className="num"
                inputMode="decimal"
                placeholder="value"
                value={draft.value}
                onChange={(e) => setDraft({ ...draft, value: e.target.value })}
                onKeyDown={(e) => onKey(e, add)}
              />
            </td>
            <td>
              <input
                placeholder="unit"
                value={draft.unit}
                onChange={(e) => setDraft({ ...draft, unit: e.target.value })}
                onKeyDown={(e) => onKey(e, add)}
              />
            </td>
            <td className="actions">
              <button className="btn small primary" onClick={add}>
                Add
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      {draftError && <p className="error-text small">{draftError}</p>}
    </section>
  )
}
