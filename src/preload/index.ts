import { contextBridge, ipcRenderer } from 'electron'
import type { LedgerApi } from '../shared/types'

const api: LedgerApi = {
  info: () => ipcRenderer.invoke('app:info'),

  listExperiments: () => ipcRenderer.invoke('experiments:list'),
  createExperiment: (input) => ipcRenderer.invoke('experiments:create', input),
  updateExperiment: (id, input) => ipcRenderer.invoke('experiments:update', id, input),
  deleteExperiment: (id) => ipcRenderer.invoke('experiments:delete', id),
  compareRuns: (experimentId) => ipcRenderer.invoke('experiments:compare', experimentId),
  exportComparisonCsv: (experimentId) => ipcRenderer.invoke('experiments:exportCsv', experimentId),

  listRuns: (experimentId) => ipcRenderer.invoke('runs:list', experimentId),
  createRun: (experimentId, input) => ipcRenderer.invoke('runs:create', experimentId, input),
  updateRun: (id, input) => ipcRenderer.invoke('runs:update', id, input),
  deleteRun: (id) => ipcRenderer.invoke('runs:delete', id),

  listResults: (runId) => ipcRenderer.invoke('results:list', runId),
  addResults: (runId, inputs) => ipcRenderer.invoke('results:add', runId, inputs),
  updateResult: (id, input) => ipcRenderer.invoke('results:update', id, input),
  deleteResult: (id) => ipcRenderer.invoke('results:delete', id),

  listFiles: (runId) => ipcRenderer.invoke('files:list', runId),
  attachFiles: (runId) => ipcRenderer.invoke('files:attach', runId),
  openFile: (id) => ipcRenderer.invoke('files:open', id),
  revealFile: (id) => ipcRenderer.invoke('files:reveal', id),
  deleteFile: (id) => ipcRenderer.invoke('files:delete', id)
}

contextBridge.exposeInMainWorld('ledger', api)
