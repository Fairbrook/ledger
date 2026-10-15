import { useEffect, useState } from 'react'
import type { RemoteStatus } from '@shared/types'
import { api, cleanError } from '../api'
import Modal from './Modal'
import { useUi } from './Ui'

/** Remote backup settings: which rclone remote mirrors run files, and the rclone binary to use. */
export default function SettingsForm(props: { onClose: () => void }) {
  const ui = useUi()
  const [remote, setRemote] = useState('')
  const [rcloneBin, setRcloneBin] = useState('')
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
  }, [ui])

  const fromEnv = source === 'env'

  const save = async (): Promise<boolean> => {
    try {
      await api.saveRemoteSettings({ remote, rcloneBin })
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
    <Modal title="Remote backup" onClose={props.onClose}>
      <form
        onSubmit={async (ev) => {
          ev.preventDefault()
          if (await save()) {
            ui.toast('Settings saved')
            props.onClose()
          }
        }}
      >
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
