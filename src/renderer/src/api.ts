import type { LedgerApi } from '@shared/types'

declare global {
  interface Window {
    ledger: LedgerApi
  }
}

export const api = window.ledger

export const cleanError = (e: unknown) =>
  String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** Local date-time in the format <input type="datetime-local"> uses (YYYY-MM-DDTHH:mm). */
export const nowLocal = () => {
  const d = new Date()
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset())
  return d.toISOString().slice(0, 16)
}

export const formatDate = (s: string) => {
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return s
  const hasTime = s.includes('T')
  return d.toLocaleString(undefined, hasTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' })
}

export const formatBytes = (n: number) => {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`
}

export const formatNumber = (v: number) =>
  Number.isInteger(v) ? String(v) : Math.abs(v) >= 1e6 || Math.abs(v) < 1e-3 ? v.toExponential(3) : String(+v.toPrecision(6))

export const runLabel = (r: { seq: number; title: string }) => `#${r.seq}${r.title ? ` ${r.title}` : ''}`
