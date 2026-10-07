import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { openDatabase } from '../src/main/db'
import { startApiServer } from '../src/main/http'
import { Ledger } from '../src/main/ledger'
import { createMcpServer } from '../src/main/mcp'
import { analyze, patchRun, registerExperiment } from '../src/main/service'

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-api-'))
  const db = openDatabase(path.join(root, 'ledger.db'))
  const ledger = new Ledger(db, path.join(root, 'files'))
  return {
    root,
    ledger,
    done: () => {
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
}

const pid = {
  name: 'PID tuning',
  subject: 'Altitude controller',
  runs: [
    { params: { Kp: 1.0, filter: 'none' }, outcome: 'partial' as const, results: [{ label: 'overshoot', value: 9, unit: '%' }] },
    { params: { Kp: 1.2, filter: 'lpf' }, outcome: 'success' as const, results: [{ label: 'overshoot', value: 4, unit: '%' }] },
    { params: { Kp: 1.4, filter: 'lpf' }, outcome: 'failure' as const, results: [{ label: 'overshoot', value: 2, unit: '%' }] }
  ]
}

test('service: register with runs, partial updates, merge params, analysis', () => {
  const { ledger, done } = setup()
  try {
    const e = registerExperiment(ledger, pid)
    assert.equal(e.status, 'running')
    assert.deepEqual(e.runs.map((r) => r.seq), [1, 2, 3])
    assert.deepEqual(e.runs[0].params, [{ key: 'Kp', value: '1' }, { key: 'filter', value: 'none' }])
    assert.equal(e.runs[1].results[0].value, 4)

    // A bad run rolls back the whole registration.
    assert.throws(() => registerExperiment(ledger, { name: 'bad', runs: [{ results: [{ label: 'x', value: NaN, unit: '' }] }] }))
    assert.equal(ledger.listExperiments().length, 1)

    const a = analyze(ledger, e.id)
    assert.deepEqual(a.outcomes, { pending: 0, success: 1, partial: 1, failure: 1, inconclusive: 0 })
    const m = a.metrics[0]
    assert.equal(m.n, 3)
    assert.equal(m.mean, 5)
    assert.deepEqual(m.min, { value: 2, runSeq: 3 })
    assert.deepEqual(m.first, { value: 9, runSeq: 1 })
    const kp = a.paramEffects.find((p) => p.param === 'Kp')!
    assert.ok(kp.numeric!.correlation! < -0.9)
    assert.equal(Math.round(kp.numeric!.slope!), -18)
    const filter = a.paramEffects.find((p) => p.param === 'filter')!
    assert.equal(filter.numeric, undefined)
    assert.deepEqual(filter.groups, [
      { value: 'none', n: 1, mean: 9 },
      { value: 'lpf', n: 2, mean: 3 }
    ])

    const r = patchRun(ledger, e.runs[0].id, { notes: 'oscillates', mergeParams: { filter: '', seed: 7 } })
    assert.equal(r.notes, 'oscillates')
    assert.equal(r.outcome, 'partial', 'untouched fields are kept')
    assert.deepEqual(r.params, [{ key: 'Kp', value: '1' }, { key: 'seed', value: '7' }])
  } finally {
    done()
  }
})

test('http: register, read, modify and analyse over the local API', async () => {
  const { root, ledger, done } = setup()
  let changes = 0
  const { server, url } = await startApiServer(ledger, { port: 0, onChange: () => changes++ })
  const call = async (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(url + p, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    const text = await res.text()
    const type = res.headers.get('content-type') ?? ''
    return { status: res.status, body: type.includes('json') && text ? JSON.parse(text) : text }
  }
  try {
    const created = await call('POST', '/experiments', pid)
    assert.equal(created.status, 201)
    const id = created.body.id
    assert.equal(created.body.runs.length, 3)

    assert.equal((await call('GET', '/experiments?q=altitude')).body.length, 1)
    assert.equal((await call('GET', '/experiments?status=planning')).body.length, 0)

    const patched = await call('PATCH', `/experiments/${id}`, { status: 'concluded', conclusions: 'Kp = 1.2' })
    assert.equal(patched.body.status, 'concluded')
    assert.equal(patched.body.subject, 'Altitude controller')

    const src = path.join(root, 'log.txt')
    fs.writeFileSync(src, 'hello')
    const run = await call('POST', `/experiments/${id}/runs`, {
      params: [{ key: 'Kp', value: '1.3' }],
      results: [{ label: 'overshoot', value: '3', unit: '%' }],
      files: [src]
    })
    assert.equal(run.status, 201)
    assert.equal(run.body.seq, 4)
    assert.equal(run.body.files[0].filename, 'log.txt')

    const more = await call('POST', `/runs/${run.body.id}/results`, [{ label: 'rise time', value: 0.4, unit: 's' }])
    assert.equal(more.status, 201)
    const upd = await call('PATCH', `/results/${more.body[0].id}`, { value: 0.5 })
    assert.equal(upd.body.value, 0.5)
    assert.equal(upd.body.label, 'rise time')

    const csv = await call('GET', `/experiments/${id}/compare.csv`)
    assert.match(csv.body, /^run,title,date,outcome,Kp,filter,overshoot \[%\],rise time \[s\]\n/)
    const analysis = await call('GET', `/experiments/${id}/analysis`)
    assert.equal(analysis.body.runCount, 4)

    // Errors: validation 400, missing 404, unknown route 404, wrong method 405.
    assert.equal((await call('POST', '/experiments', { name: ' ' })).status, 400)
    assert.equal((await call('GET', '/experiments/999')).status, 404)
    assert.equal((await call('DELETE', '/runs/999')).status, 404)
    assert.equal((await call('GET', '/nope')).status, 404)
    assert.equal((await call('PUT', `/experiments/${id}`, {})).status, 405)

    // Browsers (any Origin header) are refused.
    assert.equal((await call('GET', '/experiments', undefined, { Origin: 'https://evil.example' })).status, 403)

    assert.equal((await call('DELETE', `/runs/${run.body.id}`)).status, 204)
    assert.equal((await call('GET', `/experiments/${id}`)).body.runs.length, 3)
    assert.equal(changes, 6, 'onChange fires once per successful write')
  } finally {
    server.close()
    done()
  }
})

test('http: bearer token is enforced when configured', async () => {
  const { ledger, done } = setup()
  const { server, url } = await startApiServer(ledger, { port: 0, token: 's3cret' })
  try {
    assert.equal((await fetch(`${url}/experiments`)).status, 401)
    assert.equal((await fetch(`${url}/experiments`, { headers: { Authorization: 'Bearer s3cret' } })).status, 200)
  } finally {
    server.close()
    done()
  }
})

test('mcp: tools register, modify and analyse experiments', async () => {
  const { root, ledger, done } = setup()
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  await createMcpServer(ledger).connect(serverT)
  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(clientT)
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean }
    const text = res.content[0].text
    return { isError: !!res.isError, text, json: () => JSON.parse(text) }
  }
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name)
    for (const t of ['register_experiment', 'update_run', 'analyze_experiment', 'compare_runs', 'read_run_file'])
      assert.ok(tools.includes(t), t)

    const e = (await call('register_experiment', pid)).json()
    assert.equal(e.runs.length, 3)

    const src = path.join(root, 'trace.csv')
    fs.writeFileSync(src, 't,alt\n0,0\n1,1.1\n')
    const run = (
      await call('log_run', { experiment_id: e.id, params: { Kp: 1.3 }, outcome: 'success', files: [src] })
    ).json()
    assert.equal(run.seq, 4)
    assert.equal((await call('read_run_file', { file_id: run.files[0].id })).text, 't,alt\n0,0\n1,1.1\n')

    const upd = (await call('update_run', { run_id: run.id, merge_params: { filter: 'lpf' } })).json()
    assert.deepEqual(upd.params, [{ key: 'Kp', value: '1.3' }, { key: 'filter', value: 'lpf' }])

    const exp = (await call('update_experiment', { experiment_id: e.id, conclusions: 'done', status: 'concluded' })).json()
    assert.equal(exp.status, 'concluded')

    assert.match((await call('compare_runs', { experiment_id: e.id })).text, /^run,title,date,outcome,Kp,filter,overshoot \[%\]/)
    assert.equal((await call('analyze_experiment', { experiment_id: e.id })).json().runCount, 4)
    assert.equal((await call('list_experiments', { status: 'concluded' })).json().length, 1)

    const missing = await call('get_experiment', { experiment_id: 999 })
    assert.ok(missing.isError)
    assert.match(missing.text, /not found/)
  } finally {
    await client.close()
    done()
  }
})
