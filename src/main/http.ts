import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { comparisonToCsv } from './csv'
import { NotFoundError, type Ledger } from './ledger'
import {
  analyze,
  findExperiments,
  getExperimentDetail,
  getRunDetail,
  logRun,
  normalizeResult,
  patchExperiment,
  patchRun,
  registerExperiment
} from './service'

export const DEFAULT_API_PORT = 4317

export interface ApiOptions {
  port?: number
  host?: string
  /** If set, every request needs `Authorization: Bearer <token>`. */
  token?: string
  /** Called after every successful write, e.g. to refresh the UI. */
  onChange?: () => void
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

type Params = Record<string, string>
type Handler = (ctx: { params: Params; query: URLSearchParams; body: any }) => unknown
interface Route {
  method: string
  pattern: RegExp
  keys: string[]
  handler: Handler
  write: boolean
}

const MAX_BODY = 1024 * 1024

/**
 * Local REST API over the ledger, JSON in and out. It only listens on the loopback interface and
 * refuses browser requests (any `Origin` header) and foreign `Host` headers, so web pages can't reach it.
 */
export function createApiServer(ledger: Ledger, opts: ApiOptions = {}): http.Server {
  const routes: Route[] = []
  const add = (method: string, path: string, handler: Handler) => {
    const keys: string[] = []
    const pattern = new RegExp(
      '^' +
        path.replace(/:(\w+)/g, (_, k) => {
          keys.push(k)
          return '(\\d+)'
        }) +
        '$'
    )
    routes.push({ method, pattern, keys, handler, write: method !== 'GET' })
  }
  const id = (p: Params, k = 'id') => Number(p[k])

  add('GET', '/api/health', () => ({ ok: true }))

  add('GET', '/api/experiments', ({ query }) =>
    findExperiments(ledger, query.get('q') ?? '', query.get('status') ?? undefined)
  )
  add('POST', '/api/experiments', ({ body }) => created(registerExperiment(ledger, object(body))))
  add('GET', '/api/experiments/:id', ({ params }) => getExperimentDetail(ledger, id(params)))
  add('PATCH', '/api/experiments/:id', ({ params, body }) => patchExperiment(ledger, id(params), object(body)))
  add('DELETE', '/api/experiments/:id', ({ params }) => {
    ledger.getExperiment(id(params))
    ledger.deleteExperiment(id(params))
  })
  add('GET', '/api/experiments/:id/compare', ({ params }) => ledger.compare(id(params)))
  add('GET', '/api/experiments/:id/compare.csv', ({ params }) => csv(comparisonToCsv(ledger.compare(id(params)))))
  add('GET', '/api/experiments/:id/analysis', ({ params }) => analyze(ledger, id(params)))

  add('GET', '/api/experiments/:id/runs', ({ params }) => {
    ledger.getExperiment(id(params))
    return ledger.listRuns(id(params))
  })
  add('POST', '/api/experiments/:id/runs', ({ params, body }) => created(logRun(ledger, id(params), object(body))))
  add('GET', '/api/runs/:id', ({ params }) => getRunDetail(ledger, id(params)))
  add('PATCH', '/api/runs/:id', ({ params, body }) => patchRun(ledger, id(params), object(body)))
  add('DELETE', '/api/runs/:id', ({ params }) => ledger.deleteRun(id(params)))

  add('POST', '/api/runs/:id/results', ({ params, body }) => {
    const list = Array.isArray(body) ? body : object(body).results
    if (!Array.isArray(list)) throw new HttpError(400, 'Expected an array of results or { "results": [...] }')
    return created(ledger.addResults(id(params), list.map(normalizeResult)))
  })
  add('PATCH', '/api/results/:id', ({ params, body }) => {
    const cur = ledger.getResult(id(params))
    return ledger.updateResult(id(params), normalizeResult({ ...cur, ...object(body) }))
  })
  add('DELETE', '/api/results/:id', ({ params }) => {
    ledger.getResult(id(params))
    ledger.deleteResult(id(params))
  })

  add('POST', '/api/runs/:id/files', ({ params, body }) => {
    const paths = object(body).paths
    if (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string'))
      throw new HttpError(400, 'Expected { "paths": ["/absolute/path", ...] }')
    return created(ledger.attachFiles(id(params), paths))
  })
  add('DELETE', '/api/files/:id', ({ params }) => ledger.deleteFile(id(params)))

  const server = http.createServer(async (req, res) => {
    try {
      checkOrigin(req, server)
      if (opts.token && req.headers.authorization !== `Bearer ${opts.token}`)
        throw new HttpError(401, 'Missing or wrong bearer token')

      const url = new URL(req.url ?? '/', 'http://localhost')
      const matches = routes.filter((r) => r.pattern.test(url.pathname))
      if (matches.length === 0) throw new HttpError(404, `No route for ${url.pathname}`)
      const route = matches.find((r) => r.method === req.method)
      if (!route) throw new HttpError(405, `${req.method} not allowed on ${url.pathname}`)

      const m = route.pattern.exec(url.pathname)!
      const params = Object.fromEntries(route.keys.map((k, i) => [k, m[i + 1]]))
      const body = route.write ? await readJson(req) : undefined
      const out = route.handler({ params, query: url.searchParams, body })
      if (route.write) opts.onChange?.()
      send(res, out)
    } catch (err) {
      const status = err instanceof HttpError ? err.status : err instanceof NotFoundError ? 404 : 400
      sendJson(res, status, { error: (err as Error)?.message ?? String(err) })
    }
  })
  return server
}

/** Starts the API and resolves with its base URL once it is listening. */
export function startApiServer(ledger: Ledger, opts: ApiOptions = {}): Promise<{ server: http.Server; url: string }> {
  const server = createApiServer(ledger, opts)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? DEFAULT_API_PORT, opts.host ?? '127.0.0.1', () => {
      server.off('error', reject)
      const { address, port } = server.address() as AddressInfo
      resolve({ server, url: `http://${address.includes(':') ? `[${address}]` : address}:${port}/api` })
    })
  })
}

// ---- helpers ------------------------------------------------------------------------

const CREATED = Symbol('created')
const CSV = Symbol('csv')
const created = <T>(value: T) => ({ [CREATED]: value })
const csv = (text: string) => ({ [CSV]: text })

function send(res: http.ServerResponse, out: any) {
  if (out === undefined) {
    res.writeHead(204).end()
  } else if (out && CREATED in out) {
    sendJson(res, 201, out[CREATED])
  } else if (out && CSV in out) {
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8' }).end(out[CSV])
  } else {
    sendJson(res, 200, out)
  }
}

function sendJson(res: http.ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(value, null, 2))
}

function object(body: unknown): any {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Expected a JSON object')
  return body
}

/** Blocks browsers (CSRF from web pages) and DNS-rebinding: no Origin header, Host must be loopback. */
function checkOrigin(req: http.IncomingMessage, server: http.Server) {
  if (req.headers.origin) throw new HttpError(403, 'Browser requests are not allowed')
  const host = (req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  if (host && !['localhost', '127.0.0.1', '::1'].includes(host)) {
    const addr = server.address() as AddressInfo | null
    if (host !== addr?.address) throw new HttpError(403, `Host "${host}" is not allowed`)
  }
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new HttpError(413, 'Request body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON')
  }
}
