import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDatabase } from '../src/main/db'
import { Ledger } from '../src/main/ledger'
import { buildArgv, launch, matchRule, normalizeRules, parseCommand, readRules, saveRules } from '../src/main/openWith'
import { programName } from '../src/shared/openWith'

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-ow-'))
  return new Ledger(openDatabase(path.join(root, 'ledger.db')), path.join(root, 'files'))
}

test('parseCommand splits on whitespace and honours quotes', () => {
  assert.deepEqual(parseCommand('rerun'), ['rerun'])
  assert.deepEqual(parseCommand('  code  -n   {file} '), ['code', '-n', '{file}'])
  assert.deepEqual(parseCommand('"/opt/My App/viewer" --flag'), ['/opt/My App/viewer', '--flag'])
  assert.deepEqual(parseCommand("'a b' c"), ['a b', 'c'])
  assert.deepEqual(parseCommand('a\\ b c'), ['a b', 'c'])
  assert.deepEqual(parseCommand('x ""'), ['x', ''])
  assert.deepEqual(parseCommand(''), [])
})

test('buildArgv substitutes {file} or appends the path', () => {
  assert.deepEqual(buildArgv('rerun', '/d/a b.rrd'), { cmd: 'rerun', args: ['/d/a b.rrd'] })
  assert.deepEqual(buildArgv('code -n {file}', '/d/x.rrd'), { cmd: 'code', args: ['-n', '/d/x.rrd'] })
  assert.deepEqual(buildArgv('v --open={file} -q', '/d/x'), { cmd: 'v', args: ['--open=/d/x', '-q'] })
  assert.throws(() => buildArgv('   ', '/d/x'), /Empty/)
})

test('normalizeRules cleans extensions and drops incomplete or duplicate rows', () => {
  assert.deepEqual(
    normalizeRules([
      { ext: ' .RRD ', command: ' rerun ' },
      { ext: 'rrd', command: 'other' },
      { ext: '', command: 'x' },
      { ext: 'csv', command: '' }
    ]),
    [{ ext: 'rrd', command: 'rerun' }]
  )
})

test('matchRule is case-insensitive and prefers the longest suffix', () => {
  const rules = [
    { ext: 'gz', command: 'a' },
    { ext: 'tar.gz', command: 'b' },
    { ext: 'rrd', command: 'rerun' }
  ]
  assert.equal(matchRule(rules, 'sub/Run.RRD')?.command, 'rerun')
  assert.equal(matchRule(rules, 'logs/x.tar.gz')?.command, 'b')
  assert.equal(matchRule(rules, 'x.gz')?.command, 'a')
  assert.equal(matchRule(rules, 'notes.txt'), null)
  assert.equal(matchRule(rules, '.rrd'), null)
  assert.equal(matchRule(rules, 'rrd'), null)
})

test('programName shortens a command for labels', () => {
  assert.equal(programName('rerun'), 'rerun')
  assert.equal(programName('/home/me/.local/bin/rerun --x'), 'rerun')
  assert.equal(programName('"/opt/My App/viewer" -n'), 'viewer')
})

test('rules round-trip through settings and bad JSON reads as empty', () => {
  const ledger = setup()
  assert.deepEqual(readRules(ledger), [])
  assert.deepEqual(saveRules(ledger, [{ ext: '.RRD', command: 'rerun' }]), [{ ext: 'rrd', command: 'rerun' }])
  assert.deepEqual(readRules(ledger), [{ ext: 'rrd', command: 'rerun' }])
  saveRules(ledger, [])
  assert.equal(ledger.getSetting('openWith'), null)
  ledger.setSetting('openWith', '{not json')
  assert.deepEqual(readRules(ledger), [])
  ledger.setSetting('openWith', '{"ext":"a"}')
  assert.deepEqual(readRules(ledger), [])
})

test('launch resolves for a real program and rejects with a hint when it is missing', async () => {
  await launch(process.execPath, ['-e', '0'])
  await assert.rejects(launch('ledger-no-such-program-xyz', []), /not found.*Settings/)
})
