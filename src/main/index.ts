import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { comparisonToCsv } from './csv'
import { openDatabase } from './db'
import { Ledger } from './ledger'
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

app.whenReady().then(() => {
  const dataDir = process.env.LEDGER_DATA_DIR || path.join(app.getPath('userData'), 'data')
  const info: AppInfo = {
    dataDir,
    dbFile: path.join(dataDir, 'ledger.db'),
    filesRoot: process.env.LEDGER_FILES_DIR || path.join(dataDir, 'experiment_files')
  }
  const db = openDatabase(info.dbFile)
  const ledger = new Ledger(db, info.filesRoot)
  console.log(`[ledger] database ready at ${info.dbFile}`)
  app.on('will-quit', () => db.close())

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
