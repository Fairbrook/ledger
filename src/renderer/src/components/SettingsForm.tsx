import { useEffect, useState } from 'react'
import type { OpenWithRule, RemoteStatus } from '@shared/types'
import { api, cleanError } from '../api'
import { Icon, IconButton } from './Icons'
import Modal from './Modal'
import { useUi } from './Ui'

/** Fired on `window` after the "Open with" rules are saved, so open file lists refresh their labels. */
export const OPEN_WITH_CHANGED = 'ledger:open-with-changed'

/** App settings: remote backup (rclone remote and binary) and which program opens each file extension. */
export default function SettingsForm(props: { onClose: () => void }) {
  const ui = useUi()
  const [remote, setRemote] = useState('')
  const [rcloneBin, setRcloneBin] = useState('')
  const [rules, setRules] = useState<OpenWithRule[]>([])
  const [source, setSource] = useState<RemoteStatus['source']>(null)
  const [status, setStatus] = useState<RemoteStatus | null>(null)
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api
      .getRemoteSettings()
      .then((s) => {
        setRemote(s.remote)
        setRcloneBin(s.rcloneBin)
        setSource(s.source)
      })
      .catch(ui.fail)
    api.remoteStatus().then(setStatus).catch(ui.fail)
    api.getOpenWith().then(setRules).catch(ui.fail)
  }, [ui])

  const fromEnv = source === 'env'

  const updateRule = (i: number, patch: Partial<OpenWithRule>) =>
    setRules((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  const browse = async (i: number) => {
    try {
      const picked = await api.pickProgram()
      if (!picked) return
      // Quote paths with spaces so the command line splits back into the same executable.
      updateRule(i, { command: /\s/.test(picked) ? `"${picked}"` : picked })
    } catch (e) {
      ui.fail(e)
    }
  }

  const save = async (): Promise<boolean> => {
    try {
      await api.saveRemoteSettings({ remote, rcloneBin })
      setRules(await api.saveOpenWith(rules))
      window.dispatchEvent(new Event(OPEN_WITH_CHANGED))
      setStatus(await api.remoteStatus())
      return true
    } catch (e) {
      ui.fail(e)
      return false
    }
  }

  const test = async () => {
    setBusy(true)
    setTestResult(null)
    if (await save()) {
      try {
        setTestResult({ ok: true, text: await api.testRemote() })
      } catch (e) {
        setTestResult({ ok: false, text: cleanError(e) })
      }
    }
    setBusy(false)
  }

  return (
    <Modal title="Settings" onClose={props.onClose}>
      <form
        onSubmit={async (ev) => {
          ev.preventDefault()
          if (await save()) {
            ui.toast('Settings saved')
            props.onClose()
          }
        }}
      >
        <h3 className="settings-section">Remote backup</h3>
        <p className="muted small">
          Attached files are copied to an{' '}
          <a href="https://rclone.org/docs/" target="_blank" rel="noreferrer">
            rclone
          </a>{' '}
          remote in the background, so finished runs can be archived (local files deleted, remote copy kept). Create the
          remote first with <code>rclone config</code>.
        </p>
        <label className="field">
          <span>Remote path</span>
          <input
            autoFocus
            value={remote}
            disabled={fromEnv}
            onChange={(ev) => setRemote(ev.target.value)}
            placeholder="gdrive:ledger"
          />
          {fromEnv && <small className="muted">Set by LEDGER_RCLONE_REMOTE; unset it to edit here.</small>}
        </label>
        <label className="field">
          <span>rclone executable (optional)</span>
          <input value={rcloneBin} onChange={(ev) => setRcloneBin(ev.target.value)} placeholder="rclone" />
        </label>
        {testResult && (
          <p className={testResult.ok ? 'small' : 'small error-text'} role="status">
            {testResult.text}
          </p>
        )}
        {status && (
          <p className="muted small">
            {status.configured
              ? `${status.pending} file${status.pending === 1 ? '' : 's'} waiting to upload.`
              : 'No remote configured: files stay local and runs cannot be archived.'}
            {status.lastError && <span className="error-text"> Last error: {status.lastError}</span>}
          </p>
        )}
        <h3 className="settings-section">Open with</h3>
        <p className="muted small">
          Open files with a specific program instead of the system default. Use <code>{'{file}'}</code> in the command
          to place the path; otherwise it is appended. Files with no rule open with the system default.
        </p>
        <div className="open-with-rows">
          {rules.map((r, i) => (
            <div className="open-with-row" key={i}>
              <input
                value={r.ext}
                onChange={(ev) => updateRule(i, { ext: ev.target.value })}
                placeholder="rrd"
                aria-label="File extension"
              />
              <input
                value={r.command}
                onChange={(ev) => updateRule(i, { command: ev.target.value })}
                placeholder="rerun"
                aria-label="Program command"
              />
              <button type="button" className="btn small subtle" onClick={() => browse(i)}>
                Browse…
              </button>
              <IconButton
                icon="trash"
                label="Remove"
                danger
                onClick={() => setRules((prev) => prev.filter((_, j) => j !== i))}
              />
            </div>
          ))}
        </div>
        <button type="button" className="btn small" onClick={() => setRules((prev) => [...prev, { ext: '', command: '' }])}>
          <Icon name="plus" size={14} /> Add program
        </button>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={test} disabled={busy || !remote.trim()}>
            Test connection
          </button>
          <span className="spacer" />
          <button type="button" className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  )
}
