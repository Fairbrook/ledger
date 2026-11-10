import type { OpenWithRule } from './types'

/** The rule whose extension is the longest suffix of the file name ("tar.gz" beats "gz"), or null. */
export function matchRule(rules: OpenWithRule[], filename: string): OpenWithRule | null {
  const name = (filename.split('/').pop() ?? filename).toLowerCase()
  let best: OpenWithRule | null = null
  for (const r of rules) {
    if (!name.endsWith(`.${r.ext}`) || name.length === r.ext.length + 1) continue
    if (!best || r.ext.length > best.ext.length) best = r
  }
  return best
}

/** Short program name for labels: the first word of the command, without its directory. */
export function programName(command: string): string {
  const first = command.trim().match(/^"([^"]*)"|^'([^']*)'|^\S+/)
  const raw = first ? (first[1] ?? first[2] ?? first[0]) : command
  return raw.split('/').pop() || raw
}
