// Headless local API: serves the ledger database over HTTP without opening the desktop app.
//   npm run api            (LEDGER_API_PORT, LEDGER_API_HOST, LEDGER_API_TOKEN, LEDGER_DATA_DIR)
import { RemoteSync } from '../main/archive'
import { openDatabase } from '../main/db'
import { DEFAULT_API_PORT, startApiServer } from '../main/http'
import { Ledger } from '../main/ledger'
import { resolvePaths } from '../main/paths'
import { remoteFromConfig } from '../main/remote'

const paths = resolvePaths()
const db = openDatabase(paths.dbFile)
const ledger = new Ledger(db, paths.filesRoot)

const sync = new RemoteSync(ledger, () => remoteFromConfig(ledger))
sync.start()

startApiServer(ledger, {
  sync,
  port: Number(process.env.LEDGER_API_PORT) || DEFAULT_API_PORT,
  host: process.env.LEDGER_API_HOST,
  token: process.env.LEDGER_API_TOKEN || undefined
}).then(
  ({ url }) => console.log(`[ledger] API listening on ${url} (database ${paths.dbFile})`),
  (err) => {
    console.error(`[ledger] could not start the API: ${err.message}`)
    process.exit(1)
  }
)

for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.on(sig, () => {
    sync.stop()
    db.close()
    process.exit(0)
  })
