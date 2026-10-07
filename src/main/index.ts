import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { comparisonToCsv } from './csv'
import { openDatabase } from './db'
import { DEFAULT_API_PORT, startApiServer } from './http'
import { Ledger } from './ledger'
import { resolvePaths } from './paths'
import type { AppInfo, ExperimentInput, ResultInput, RunInput } from '../shared/types'

let win: BrowserWindow | null = null

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    title: 'ledger',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win?.webContents.getURL()) e.preventDefault()
  })
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(async () => {
  const info: AppInfo = { ...resolvePaths(app.getPath('userData')), apiUrl: null }
  const db = openDatabase(info.dbFile)
  const ledger = new Ledger(db, info.filesRoot)
  console.log(`[ledger] database ready at ${info.dbFile}`)

  // Tell the window to reload when data changes outside it: through the local API (same connection),
  // or from another process such as the MCP server (PRAGMA data_version only moves on other connections' commits).
  const notifyChanged = () => win?.webContents.send('ledger:changed')
  const dataVersion = () => (db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version
  let lastVersion = dataVersion()
  const poll = setInterval(() => {
    const v = dataVersion()
    if (v !== lastVersion) {
      lastVersion = v
      notifyChanged()
    }
  }, 1000)

  // Local HTTP API on the loopback interface. LEDGER_API=0 turns it off.
  let apiServer: Awaited<ReturnType<typeof startApiServer>>['server'] | null = null
  if (process.env.LEDGER_API !== '0') {
    try {
      const started = await startApiServer(ledger, {
        port: Number(process.env.LEDGER_API_PORT) || DEFAULT_API_PORT,
        token: process.env.LEDGER_API_TOKEN || undefined,
        onChange: notifyChanged
      })
      apiServer = started.server
      info.apiUrl = started.url
      console.log(`[ledger] API listening on ${started.url}`)
    } catch (err) {
      console.warn(`[ledger] local API not started: ${(err as Error).message}`)
    }
  }

  app.on('will-quit', () => {
    clearInterval(poll)
    apiServer?.close()
    db.close()
  })

  ipcMain.handle('app:info', () => info)

  ipcMain.handle('experiments:list', () => ledger.listExperiments())
  ipcMain.handle('experiments:create', (_e, input: ExperimentInput) => ledger.createExperiment(input))
  ipcMain.handle('experiments:update', (_e, id: number, input: ExperimentInput) => ledger.updateExperiment(id, input))
  ipcMain.handle('experiments:delete', (_e, id: number) => ledger.deleteExperiment(id))
  ipcMain.handle('experiments:compare', (_e, id: number) => ledger.compare(id))
  ipcMain.handle('experiments:exportCsv', async (_e, id: number) => {
    const exp = ledger.getExperiment(id)
    const safe = exp.name.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || `experiment-${id}`
    const res = await dialog.showSaveDialog(win!, {
      title: 'Export runs as CSV',
      defaultPath: `${safe}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    })
    if (res.canceled || !res.filePath) return null
    fs.writeFileSync(res.filePath, comparisonToCsv(ledger.compare(id)))
    return res.filePath
  })

  ipcMain.handle('runs:list', (_e, experimentId: number) => ledger.listRuns(experimentId))
  ipcMain.handle('runs:create', (_e, experimentId: number, input: RunInput) => ledger.createRun(experimentId, input))
  ipcMain.handle('runs:update', (_e, id: number, input: RunInput) => ledger.updateRun(id, input))
  ipcMain.handle('runs:delete', (_e, id: number) => ledger.deleteRun(id))

  ipcMain.handle('results:list', (_e, runId: number) => ledger.listResults(runId))
  ipcMain.handle('results:add', (_e, runId: number, inputs: ResultInput[]) => ledger.addResults(runId, inputs))
  ipcMain.handle('results:update', (_e, id: number, input: ResultInput) => ledger.updateResult(id, input))
  ipcMain.handle('results:delete', (_e, id: number) => ledger.deleteResult(id))

  ipcMain.handle('files:list', (_e, runId: number) => ledger.listFiles(runId))
  // The picker runs here, so the renderer never supplies arbitrary paths to copy.
  ipcMain.handle('files:attach', async (_e, runId: number) => {
    const res = await dialog.showOpenDialog(win!, {
      title: 'Attach files to run',
      properties: ['openFile', 'multiSelections']
    })
    if (res.canceled || res.filePaths.length === 0) return []
    return ledger.attachFiles(runId, res.filePaths)
  })
  ipcMain.handle('files:open', async (_e, id: number) => {
    const err = await shell.openPath(ledger.filePath(ledger.getFile(id)))
    if (err) throw new Error(err)
  })
  ipcMain.handle('files:reveal', (_e, id: number) => shell.showItemInFolder(ledger.filePath(ledger.getFile(id))))
  ipcMain.handle('files:delete', (_e, id: number) => ledger.deleteFile(id))

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
