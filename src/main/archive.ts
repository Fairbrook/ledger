import fs from 'node:fs'
import type { Ledger } from './ledger'
import { resolveRemoteConfig, runRemotePath, type RemoteStore } from './remote'
import type { Run, RemoteStatus } from '../shared/types'

const CONCURRENCY = 2
const TICK_MS = 60_000

/**
 * Keeps the remote in step with the local files: a background queue uploads every attached file, and
 * archive/restore move a whole run's files off and back onto this computer. The database always keeps the
 * run, its results and its file records; only the bytes move.
 */
export class RemoteSync {
  private inFlight = new Set<number>()
  private draining: Promise<void> | null = null
  private timer: NodeJS.Timeout | null = null
  private lastError: string | null = null
  /** Run ids being archived or restored, so a second click or the upload queue can't race them. */
  private busyRuns = new Set<number>()

  constructor(
    private readonly ledger: Ledger,
    private readonly getRemote: () => RemoteStore | null,
    private readonly onChange: () => void = () => {}
  ) {}

  /** Uploads what is pending now, then again every minute (retries failures, picks up files attached by other processes). */
  start(): void {
    this.kick()
    this.timer = setInterval(() => this.kick(), TICK_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Starts a drain unless one is running. Never throws; errors land in `status().lastError`. */
  kick(): Promise<void> {
    this.draining ??= this.drain().finally(() => {
      this.draining = null
    })
    return this.draining
  }

  status(): RemoteStatus {
    const { settings, source } = resolveRemoteConfig(this.ledger)
    return {
      configured: this.getRemote() !== null,
      remote: settings.remote || null,
      source,
      pending: this.ledger.pendingBackups().length,
      lastError: this.lastError
    }
  }

  private async drain(): Promise<void> {
    const remote = this.getRemote()
    if (!remote) return
    let changed = false
    try {
      const queue = this.ledger.pendingBackups().filter((f) => !this.inFlight.has(f.id) && !this.busyRuns.has(f.runId))
      const work = async () => {
        for (let f = queue.shift(); f; f = queue.shift()) {
          this.inFlight.add(f.id)
          try {
            const local = this.ledger.filePath(f)
            if (!fs.existsSync(local)) continue // deleted meanwhile
            await remote.copyFile(local, f.storedPath)
            // The file may have been deleted while uploading; marking a missing row is harmless.
            this.ledger.markBackedUp([f.id])
            changed = true
          } finally {
            this.inFlight.delete(f.id)
          }
        }
      }
      await Promise.all(Array.from({ length: CONCURRENCY }, work))
      this.lastError = null
    } catch (err) {
      this.lastError = (err as Error).message
    }
    if (changed) this.onChange()
  }

  /**
   * Uploads anything missing, verifies the remote copy matches, and only then deletes the local files.
   * If any step fails the run stays untouched locally.
   */
  async archiveRun(runId: number): Promise<Run> {
    const remote = this.requireRemote()
    const run = this.ledger.getRun(runId)
    if (run.archivedAt) throw new Error(`Run #${run.seq} is already archived`)
    this.claim(runId)
    try {
      const files = this.ledger.listFiles(runId)
      const dir = this.ledger.runDir(run.experimentId, runId)
      if (files.length > 0) {
        const missing = files.filter((f) => !fs.existsSync(this.ledger.filePath(f)))
        if (missing.length > 0)
          throw new Error(`Cannot archive: ${missing.map((f) => f.filename).join(', ')} missing from local storage`)
        const rel = runRemotePath(run.experimentId, runId)
        await remote.copyDir(dir, rel)
        await remote.checkDir(dir, rel)
        this.ledger.markBackedUp(files.map((f) => f.id))
      }
      this.ledger.setArchived(runId, new Date().toISOString())
      fs.rmSync(dir, { recursive: true, force: true })
    } finally {
      this.busyRuns.delete(runId)
    }
    this.onChange()
    return this.ledger.getRun(runId)
  }

  /** Downloads an archived run's files back and marks it local again. */
  async restoreRun(runId: number): Promise<Run> {
    const remote = this.requireRemote()
    const run = this.ledger.getRun(runId)
    if (!run.archivedAt) throw new Error(`Run #${run.seq} is not archived`)
    this.claim(runId)
    try {
      const dir = this.ledger.runDir(run.experimentId, runId)
      const files = this.ledger.listFiles(runId)
      if (files.length > 0) {
        await remote.download(runRemotePath(run.experimentId, runId), dir)
        const missing = files.filter((f) => !fs.existsSync(this.ledger.filePath(f)))
        if (missing.length > 0)
          throw new Error(`Restore incomplete: ${missing.map((f) => f.filename).join(', ')} not found on the remote`)
      }
      this.ledger.setArchived(runId, null)
    } finally {
      this.busyRuns.delete(runId)
    }
    this.onChange()
    return this.ledger.getRun(runId)
  }

  /** Best-effort removal of remote copies after a local delete; failures are logged, never thrown. */
  async forget(target: { experimentId: number; runId?: number; filePath?: string }): Promise<void> {
    const remote = this.getRemote()
    if (!remote) return
    try {
      if (target.filePath) await remote.deleteFile(target.filePath)
      else if (target.runId !== undefined) await remote.purge(runRemotePath(target.experimentId, target.runId))
      else await remote.purge(String(target.experimentId))
    } catch (err) {
      console.warn(`[ledger] could not remove remote copy: ${(err as Error).message}`)
    }
  }

  private claim(runId: number) {
    if (this.busyRuns.has(runId)) throw new Error('This run is already being archived or restored')
    this.busyRuns.add(runId)
  }

  private requireRemote(): RemoteStore {
    const remote = this.getRemote()
    if (!remote) throw new Error('No remote configured. Set one in Settings (or LEDGER_RCLONE_REMOTE).')
    return remote
  }
}
