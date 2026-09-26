import type { RunFile } from '@shared/types'
import { api, formatBytes, formatDate } from '../api'
import { useUi } from './Ui'

export default function FileList(props: { runId: number; files: RunFile[]; onChanged: () => void }) {
  const ui = useUi()

  const attach = async () => {
    try {
      const added = await api.attachFiles(props.runId)
      if (added.length === 0) return
      ui.toast(`${added.length} file${added.length === 1 ? '' : 's'} attached`)
      props.onChanged()
    } catch (e) {
      ui.fail(e)
    }
  }

  const remove = async (f: RunFile) => {
    const ok = await ui.confirm({
      title: 'Delete file?',
      message: (
        <p>
          <strong>{f.filename}</strong> will be removed from this run and its stored copy deleted from disk. The
          original you attached it from is not touched.
        </p>
      )
    })
    if (!ok) return
    try {
      await api.deleteFile(f.id)
      ui.toast('File deleted')
      props.onChanged()
    } catch (e) {
      ui.fail(e)
    }
  }

  const act = (fn: () => Promise<void>) => () => fn().catch(ui.fail)
  const stored = (f: RunFile) => f.storedPath.split('/').pop()

  return (
    <section className="block">
      <div className="block-head">
        <h3>Files</h3>
        <span className="muted small">
          {props.files.length} attached
        </span>
        <span className="spacer" />
        <button className="btn small" onClick={attach}>
          Attach files…
        </button>
      </div>
      {props.files.length > 0 ? (
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th className="num">Size</th>
              <th>Added</th>
              <th className="actions" />
            </tr>
          </thead>
          <tbody>
            {props.files.map((f) => (
              <tr key={f.id} onDoubleClick={act(() => api.openFile(f.id))} title="Double-click to open">
                <td className="file-name">
                  {f.filename}
                  {stored(f) !== f.filename && <span className="muted small"> (stored as {stored(f)})</span>}
                </td>
                <td className="num nowrap">{formatBytes(f.sizeBytes)}</td>
                <td className="muted nowrap">{formatDate(f.createdAt)}</td>
                <td className="actions">
                  <button className="btn small subtle" onClick={act(() => api.openFile(f.id))}>
                    Open
                  </button>
                  <button className="btn small subtle" onClick={act(() => api.revealFile(f.id))}>
                    Show in folder
                  </button>
                  <button className="btn small subtle danger" onClick={() => remove(f)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted small">No files yet. Attach logs, CSVs, plots or recordings produced by this run.</p>
      )}
    </section>
  )
}
