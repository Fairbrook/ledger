import { useMemo, useState } from 'react'
import type { RunFile } from '@shared/types'
import { api, formatBytes, formatDate } from '../api'
import { useUi } from './Ui'

interface FolderNode {
  /** Full '/'-separated path of the folder inside the run. */
  path: string
  name: string
  folders: FolderNode[]
  files: RunFile[]
  fileCount: number
  sizeBytes: number
}

const basename = (p: string) => p.split('/').pop() ?? p

/** Groups files into a folder tree by their run-relative `filename`. */
function buildTree(files: RunFile[]): FolderNode {
  const root: FolderNode = { path: '', name: '', folders: [], files: [], fileCount: 0, sizeBytes: 0 }
  for (const f of files) {
    const parts = f.filename.split('/')
    let node = root
    root.fileCount++
    root.sizeBytes += f.sizeBytes
    for (const part of parts.slice(0, -1)) {
      let child = node.folders.find((x) => x.name === part)
      if (!child) {
        child = { path: node.path ? `${node.path}/${part}` : part, name: part, folders: [], files: [], fileCount: 0, sizeBytes: 0 }
        node.folders.push(child)
      }
      child.fileCount++
      child.sizeBytes += f.sizeBytes
      node = child
    }
    node.files.push(f)
  }
  const sort = (n: FolderNode) => {
    n.folders.sort((a, b) => a.name.localeCompare(b.name))
    n.files.sort((a, b) => basename(a.filename).localeCompare(basename(b.filename)) || a.id - b.id)
    n.folders.forEach(sort)
  }
  sort(root)
  return root
}

const plural = (n: number) => `${n} file${n === 1 ? '' : 's'}`

export default function FileList(props: { runId: number; files: RunFile[]; archived: boolean; onChanged: () => void }) {
  const ui = useUi()
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const tree = useMemo(() => buildTree(props.files), [props.files])

  const attach = async (opts?: { folder?: boolean; into?: string }) => {
    try {
      const added = await api.attachFiles(props.runId, opts)
      if (added.length === 0) return
      ui.toast(`${plural(added.length)} attached`)
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

  const removeFolder = async (node: FolderNode) => {
    const inside = props.files.filter((f) => f.filename.startsWith(`${node.path}/`))
    const ok = await ui.confirm({
      title: 'Delete folder?',
      message: (
        <p>
          <strong>{node.path}/</strong> and the {plural(inside.length)} in it will be removed from this run and their
          stored copies deleted from disk. The originals you attached them from are not touched.
        </p>
      )
    })
    if (!ok) return
    try {
      for (const f of inside) await api.deleteFile(f.id)
      ui.toast(`${plural(inside.length)} deleted`)
    } catch (e) {
      ui.fail(e)
    } finally {
      props.onChanged()
    }
  }

  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (!next.delete(path)) next.add(path)
      return next
    })

  const act = (fn: () => Promise<void>) => () => fn().catch(ui.fail)
  const stored = (f: RunFile) => f.storedPath.split('/').pop()
  const backup = (f: RunFile) =>
    props.archived ? 'remote only' : f.backedUpAt ? '✓ backed up' : 'not backed up'

  const renderFolder = (node: FolderNode, depth: number): React.ReactNode[] => {
    const open = !collapsed.has(node.path)
    const rows: React.ReactNode[] = [
      <tr key={`dir:${node.path}`} className="folder-row" onClick={() => toggle(node.path)}>
        <td className="file-name" style={{ paddingLeft: 8 + depth * 18 }}>
          <span className="tree-toggle">{open ? '▾' : '▸'}</span>
          {node.name}/
        </td>
        <td className="num nowrap muted">{formatBytes(node.sizeBytes)}</td>
        <td className="muted nowrap small">{plural(node.fileCount)}</td>
        <td />
        <td className="actions" onClick={(e) => e.stopPropagation()}>
          <button
            className="btn small subtle"
            disabled={props.archived}
            onClick={() => attach({ into: node.path })}
            title="Attach files into this folder"
          >
            Attach here…
          </button>
          <button className="btn small subtle danger" onClick={() => removeFolder(node)}>
            Delete
          </button>
        </td>
      </tr>
    ]
    if (open) rows.push(...renderChildren(node, depth + 1))
    return rows
  }

  const renderFile = (f: RunFile, depth: number) => (
    <tr
      key={f.id}
      onDoubleClick={props.archived ? undefined : act(() => api.openFile(f.id))}
      title={props.archived ? 'Archived: restore the run to open' : 'Double-click to open'}
    >
      <td className="file-name" style={{ paddingLeft: 8 + depth * 18 }}>
        {basename(f.filename)}
        {stored(f) !== basename(f.filename) && <span className="muted small"> (stored as {stored(f)})</span>}
      </td>
      <td className="num nowrap">{formatBytes(f.sizeBytes)}</td>
      <td className="muted nowrap">{formatDate(f.createdAt)}</td>
      <td className={`nowrap small ${f.backedUpAt || props.archived ? 'muted' : 'warn-text'}`}>{backup(f)}</td>
      <td className="actions">
        <button className="btn small subtle" disabled={props.archived} onClick={act(() => api.openFile(f.id))}>
          Open
        </button>
        <button className="btn small subtle" disabled={props.archived} onClick={act(() => api.revealFile(f.id))}>
          Show in folder
        </button>
        <button className="btn small subtle danger" onClick={() => remove(f)}>
          Delete
        </button>
      </td>
    </tr>
  )

  const renderChildren = (node: FolderNode, depth: number): React.ReactNode[] => [
    ...node.folders.flatMap((d) => renderFolder(d, depth)),
    ...node.files.map((f) => renderFile(f, depth))
  ]

  const restore = props.archived ? 'Restore the run to attach files' : undefined

  return (
    <section className="block">
      <div className="block-head">
        <h3>Files</h3>
        <span className="muted small">{props.files.length} attached</span>
        <span className="spacer" />
        <button className="btn small" onClick={() => attach({ folder: true })} disabled={props.archived} title={restore ?? 'Attach whole folders, keeping their structure'}>
          Attach folder…
        </button>
        <button className="btn small" onClick={() => attach()} disabled={props.archived} title={restore}>
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
              <th>Remote</th>
              <th className="actions" />
            </tr>
          </thead>
          <tbody>{renderChildren(tree, 0)}</tbody>
        </table>
      ) : (
        <p className="muted small">No files yet. Attach logs, CSVs, plots or recordings produced by this run.</p>
      )}
    </section>
  )
}
