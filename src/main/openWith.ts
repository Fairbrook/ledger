import { spawn } from 'node:child_process'
import type { OpenWithRule } from '../shared/types'

const SETTING_KEY = 'openWith'

/** Splits a command line into argv, honouring single/double quotes and backslash escapes. No shell is involved. */
export function parseCommand(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let has = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < line.length && /["\\]/.test(line[i + 1])) cur += line[++i]
      else cur += c
    } else if (c === '"' || c === "'") {
      quote = c
      has = true
    } else if (c === '\\' && i + 1 < line.length && /[\s"'\\]/.test(line[i + 1])) {
      cur += line[++i]
      has = true
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur)
      cur = ''
      has = false
    } else {
      cur += c
      has = true
    }
  }
  if (has || cur) out.push(cur)
  return out
}

/** Trims, strips leading dots, lowercases and drops incomplete or duplicate rows (the first rule per extension wins). */
export function normalizeRules(rules: OpenWithRule[]): OpenWithRule[] {
  const seen = new Set<string>()
  const out: OpenWithRule[] = []
  for (const r of rules ?? []) {
    const ext = String(r?.ext ?? '').trim().replace(/^\.+/, '').toLowerCase()
    const command = String(r?.command ?? '').trim()
    if (!ext || !command || seen.has(ext)) continue
    seen.add(ext)
    out.push({ ext, command })
  }
  return out
}

export { matchRule } from '../shared/openWith'

/** Turns a rule's command line into an executable and arguments; `{file}` is replaced, else the path is appended. */
export function buildArgv(command: string, filePath: string): { cmd: string; args: string[] } {
  const parts = parseCommand(command)
  if (parts.length === 0) throw new Error('Empty "Open with" command')
  const [cmd, ...rest] = parts
  const hasPlaceholder = rest.some((a) => a.includes('{file}'))
  const args = hasPlaceholder ? rest.map((a) => a.split('{file}').join(filePath)) : [...rest, filePath]
  return { cmd, args }
}

/** Starts a program detached from ledger. Resolves once it has spawned; rejects if it cannot be started. */
export function launch(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
    child.once('error', (err: NodeJS.ErrnoException) => {
      reject(
        new Error(
          err.code === 'ENOENT'
            ? `"${cmd}" not found. Use its full path in Settings → Open with`
            : `Could not start "${cmd}": ${err.message}`
        )
      )
    })
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

interface SettingsStore {
  getSetting(key: string): string | null
  setSetting(key: string, value: string): void
}

export function readRules(store: SettingsStore): OpenWithRule[] {
  const raw = store.getSetting(SETTING_KEY)
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? normalizeRules(parsed as OpenWithRule[]) : []
  } catch {
    return []
  }
}

export function saveRules(store: SettingsStore, rules: OpenWithRule[]): OpenWithRule[] {
  const clean = normalizeRules(rules)
  store.setSetting(SETTING_KEY, clean.length ? JSON.stringify(clean) : '')
  return clean
}
