import { execFile } from 'node:child_process'
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
  copyDir(localDir: string, remoteRel: string): Promise<void>
  copyFile(localFile: string, remoteRel: string): Promise<void>
  /** Throws unless every file in `localDir` exists on the remote with the same content. */
  checkDir(localDir: string, remoteRel: string): Promise<void>
  /** Downloads everything under `remoteRel` into `localDir`. */
  download(remoteRel: string, localDir: string): Promise<void>
  /** Removes a directory and its contents; a missing directory is not an error. */
  purge(remoteRel: string): Promise<void>
  deleteFile(remoteRel: string): Promise<void>
  /** Short description of the remote for the settings dialog; throws if it can't be reached. */
  test(): Promise<string>
}

const MAX_BUFFER = 4 * 1024 * 1024
const NOT_FOUND = /directory not found|object not found|not found|no such file/i

/** Runs rclone with an argument list (never through a shell) and rejects with its stderr on failure. */
function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout)
      if ((err as NodeJS.ErrnoException).code === 'ENOENT')
        return reject(new Error(`rclone not found ("${bin}"). Install it from rclone.org or set its path in Settings.`))
      const detail = String(stderr || err.message).trim().split('\n').slice(-3).join(' | ')
      reject(new Error(`rclone ${args[0]} failed: ${detail}`))
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

  private rclone(args: string[]) {
    return run(this.bin, [...args, '--retries', '3'])
  }

  async copyDir(localDir: string, remoteRel: string) {
    await this.rclone(['copy', localDir, this.target(remoteRel)])
  }

  async copyFile(localFile: string, remoteRel: string) {
    await this.rclone(['copyto', localFile, this.target(remoteRel)])
  }

  async checkDir(localDir: string, remoteRel: string) {
    // --one-way: only local → remote matters (extra remote files are fine); --download compares content
    // for backends without hashes instead of trusting sizes alone.
    await this.rclone(['check', localDir, this.target(remoteRel), '--one-way', '--download'])
  }

  async download(remoteRel: string, localDir: string) {
    await this.rclone(['copy', this.target(remoteRel), localDir])
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
    const version = (await run(this.bin, ['version'])).split('\n')[0].trim()
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
