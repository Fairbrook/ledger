// MCP server over stdio for Claude Code and other MCP clients. Opens the same database as the desktop app
// (or LEDGER_DATA_DIR); the app picks up changes made here while it is open. Logs go to stderr only.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { openDatabase } from '../main/db'
import { Ledger } from '../main/ledger'
import { createMcpServer } from '../main/mcp'
import { resolvePaths } from '../main/paths'

const paths = resolvePaths()
const db = openDatabase(paths.dbFile)
const ledger = new Ledger(db, paths.filesRoot)

createMcpServer(ledger)
  .connect(new StdioServerTransport())
  .then(() => console.error(`[ledger] MCP server ready (database ${paths.dbFile})`))

const close = () => {
  db.close()
  process.exit(0)
}
process.stdin.on('close', close)
process.on('SIGTERM', close)
