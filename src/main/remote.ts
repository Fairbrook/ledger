import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import type { Ledger } from './ledger'
import type { RemoteSettings, RemoteStatus } from '../shared/types'

/**
 * Where run files are mirrored. Paths are relative to the remote's base and use the same layout as the
 * local storage root (`<experimentId>/<runId>/<relative path>`). rclone is the only implementation, so the app
 * supports whatever providers rclone does; tests use a fake.
 */
export interface RemoteStore {
  /** Uploads every file in `localDir` into `remoteRel` (existing identical files are skipped). */
  copyDir(localDir: string, remoteRel: string, opts?: TransferOpts): Promise<void>
  copyFile(localFile: string, remoteRel: string): Promise<void>
  /** Throws unless every file in `localDir` exists on the remote with the same content. */
  checkDir(localDir: string, remoteRel: string, opts?: TransferOpts): Promise<void>
  /** Downloads everything under `remoteRel` into `localDir`. */
  download(remoteRel: string, localDir: string, opts?: TransferOpts): Promise<void>
  /** Removes a directory and its contents; a missing directory is not an error. */
  purge(remoteRel: string): Promise<void>
  deleteFile(remoteRel: string): Promise<void>
  /** Short description of the remote for the settings dialog; throws if it can't be reached. */
  test(): Promise<string>
}

/** rclone's running totals, as reported by its `--stats` log lines. */
export interface TransferStats {
  bytes: number
  totalBytes: number
  transfers: number
  totalTransfers: number
  checks: number
  totalChecks: number
  /** Seconds remaining as estimated by rclone, or null. */
  eta: number | null
}

export interface TransferOpts {
  /** Called about once a second while rclone works. */
  onProgress?: (stats: TransferStats) => void
  /** Aborting kills rclone and rejects with an error for which `isCancelled` is true. */
  signal?: AbortSignal
}

export const isCancelled = (err: unknown) => (err as Error)?.name === 'AbortError'

const NOT_FOUND = /directory not found|object not found|not found|no such file/i
/** rclone's note that a `check` could only compare sizes for some files because there is no common hash. */
const NO_HASH = /hashes could not be checked|no common hash/i
const STDERR_TAIL = 64 * 1024

/** rclone children still running, so quitting the app can stop them instead of leaving them behind. */
const live = new Set<ChildProcess>()

export function killAllRclone(): void {
  for (const child of live) child.kill()
}

function toStats(raw: Record<string, number | null>): TransferStats {
  return {
    bytes: raw.bytes ?? 0,
    totalBytes: raw.totalBytes ?? 0,
    transfers: raw.transfers ?? 0,
    totalTransfers: raw.totalTransfers ?? 0,
    checks: raw.checks ?? 0,
    totalChecks: raw.totalChecks ?? 0,
    eta: raw.eta ?? null
  }
}

/**
 * Runs rclone with an argument list (never through a shell). Rejects with the tail of its stderr on failure.
 * With `onProgress` it logs JSON stats lines and forwards them as they arrive.
 */
function run(bin: string, args: string[], opts: TransferOpts = {}): Promise<{ stdout: string; stderr: string }> {
  const { onProgress, signal } = opts
  const argv = onProgress ? [...args, '--use-json-log', '--stats', '1s', '--stats-log-level', 'NOTICE'] : args
  return new Promise((resolve, reject) => {
    const child = spawn(bin, argv, { stdio: ['ignore', 'pipe', 'pipe'], signal })
    live.add(child)
    let stdout = ''
    let stderr = ''
    let pending = ''
    const problems: string[] = []
    const lines: string[] = []

    const handleLine = (line: string) => {
      if (!line.trim()) return
      if (onProgress && line.startsWith('{')) {
        try {
          const entry = JSON.parse(line) as { level?: string; msg?: string; stats?: Record<string, number | null> }
          if (entry.stats) return onProgress(toStats(entry.stats))
          if (entry.msg) (/^(error|critical|fatal)$/.test(entry.level ?? '') ? problems : lines).push(entry.msg.trim())
          return
        } catch {
          // not JSON after all; keep it as plain text
        }
      }
      lines.push(line.trim())
    }

    child.stdout!.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stderr = (stderr + text).slice(-STDERR_TAIL)
      pending += text
      const parts = pending.split('\n')
      pending = parts.pop() ?? ''
      parts.forEach(handleLine)
    })
    child.on('error', (err) => {
      live.delete(child)
      if ((err as NodeJS.ErrnoException).code === 'ENOENT')
        return reject(new Error(`rclone not found ("${bin}"). Install it from rclone.org or set its path in Settings.`))
      if (isCancelled(err)) return reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' }))
      reject(err)
    })
    child.on('close', (code) => {
      live.delete(child)
      handleLine(pending)
      if (code === 0) return resolve({ stdout, stderr })
      const detail = (problems.length > 0 ? problems : lines).slice(-3).join(' | ')
      reject(new Error(`rclone ${args[0]} failed: ${detail || `exit code ${code}`}`))
    })
  })
}

export class RcloneRemote implements RemoteStore {
  constructor(
    private readonly bin: string,
    private readonly base: string
  ) {}

  /** `gdrive:ledger` + `1/2` → `gdrive:ledger/1/2`; `gdrive:` + `1` → `gdrive:1`. */
  private target(rel: string): string {
    const base = this.base.replace(/[\\/]+$/, '')
    if (!rel) return this.base
    return this.base.endsWith(':') ? `${this.base}${rel}` : `${base}/${rel}`
  }

  private rclone(args: string[], opts?: TransferOpts) {
    return run(this.bin, [...args, '--retries', '3'], opts)
  }

  async copyDir(localDir: string, remoteRel: string, opts?: TransferOpts) {
    await this.rclone(['copy', localDir, this.target(remoteRel)], opts)
  }

  async copyFile(localFile: string, remoteRel: string) {
    await this.rclone(['copyto', localFile, this.target(remoteRel)])
  }

  async checkDir(localDir: string, remoteRel: string, opts?: TransferOpts) {
    // --one-way: only local → remote matters (extra remote files are fine). Hashes are enough where the
    // backend has them; when rclone could only compare sizes, redo the check with --download, which reads
    // the remote content back (slow, so only as a fallback).
    const args = ['check', localDir, this.target(remoteRel), '--one-way']
    const { stderr } = await this.rclone(args, opts)
    if (NO_HASH.test(stderr)) await this.rclone([...args, '--download'], opts)
  }

  async download(remoteRel: string, localDir: string, opts?: TransferOpts) {
    await this.rclone(['copy', this.target(remoteRel), localDir], opts)
  }

  async purge(remoteRel: string) {
    try {
      await this.rclone(['purge', this.target(remoteRel)])
    } catch (err) {
      if (!NOT_FOUND.test((err as Error).message)) throw err
    }
  }

  async deleteFile(remoteRel: string) {
    try {
      await this.rclone(['deletefile', this.target(remoteRel)])
    } catch (err) {
      if (!NOT_FOUND.test((err as Error).message)) throw err
    }
  }

  async test() {
    const version = (await run(this.bin, ['version'])).stdout.split('\n')[0].trim()
    // lsd on a not-yet-created folder fails with "directory not found", which is fine: it is created on first upload.
    try {
      await run(this.bin, ['lsd', this.base, '--max-depth', '1'])
    } catch (err) {
      if (!NOT_FOUND.test((err as Error).message)) throw err
    }
    return `${version} — remote "${this.base}" is reachable`
  }
}

export interface ResolvedRemote {
  settings: RemoteSettings
  source: RemoteStatus['source']
}

/** Environment variables win over the Settings dialog (useful for headless runs). */
export function resolveRemoteConfig(ledger: Ledger): ResolvedRemote {
  const envRemote = process.env.LEDGER_RCLONE_REMOTE?.trim()
  const envBin = process.env.LEDGER_RCLONE_BIN?.trim()
  const remote = envRemote || ledger.getSetting('remote') || ''
  const rcloneBin = envBin || ledger.getSetting('rcloneBin') || ''
  return {
    settings: { remote, rcloneBin },
    source: envRemote ? 'env' : remote ? 'settings' : null
  }
}

/** The configured rclone remote, or null when none is set. Re-read on every call so settings apply at once. */
export function remoteFromConfig(ledger: Ledger): RemoteStore | null {
  const { settings } = resolveRemoteConfig(ledger)
  if (!settings.remote) return null
  return new RcloneRemote(settings.rcloneBin || 'rclone', settings.remote)
}

/** Forward-slash relative path of a run's folder, matching `RunFile.storedPath` prefixes. */
export const runRemotePath = (experimentId: number, runId: number) => path.posix.join(String(experimentId), String(runId))
