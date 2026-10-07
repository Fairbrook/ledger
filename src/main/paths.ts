import os from 'node:os'
import path from 'node:path'
import type { AppInfo } from '../shared/types'

/**
 * Electron's `app.getPath('userData')` for an app named "ledger", computed without Electron so the
 * headless API server and the MCP server open the same database as the desktop app.
 */
export function defaultUserDataDir(): string {
  const home = os.homedir()
  switch (process.platform) {
    case 'win32':
      return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'ledger')
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'ledger')
    default:
      return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'ledger')
  }
}

/** Where the data lives. `LEDGER_DATA_DIR` and `LEDGER_FILES_DIR` override the defaults. */
export function resolvePaths(userDataDir: string = defaultUserDataDir()): AppInfo {
  const dataDir = process.env.LEDGER_DATA_DIR || path.join(userDataDir, 'data')
  return {
    dataDir,
    dbFile: path.join(dataDir, 'ledger.db'),
    filesRoot: process.env.LEDGER_FILES_DIR || path.join(dataDir, 'experiment_files')
  }
}
