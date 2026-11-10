import fs from 'node:fs'
import type { Ledger } from './ledger'
import { resolveRemoteConfig, runRemotePath, type RemoteStore, type TransferStats } from './remote'
import type { ArchiveProgress, Run, RemoteStatus } from '../shared/types'

const CONCURRENCY = 2
const TICK_MS = 60_000
/** Progress events per run are spread at least this far apart so the window isn't flooded. */
const PROGRESS_MS = 250

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
  /** Latest progress of each archive/restore in flight, and the switch that aborts it. */
  private active = new Map<number, { progress: ArchiveProgress; abort: AbortController; sentAt: number }>()

  constructor(
    private readonly ledger: Ledger,
    private readonly getRemote: () => RemoteStore | null,
    private readonly onChange: () => void = () => {},
    private readonly onProgress: (p: ArchiveProgress) => void = () => {}
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
   * If any step fails or is cancelled the run stays untouched locally.
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
        const totalBytes = files.reduce((sum, f) => sum + f.sizeBytes, 0)
        const signal = this.active.get(runId)!.abort.signal
        const expected = { totalBytes, total: files.length }
        this.report(runId, 'archive', 'uploading', expected)
        await remote.copyDir(dir, rel, {
          signal,
          onProgress: (s) => this.report(runId, 'archive', 'uploading', expected, s, 'transfers')
        })
        this.report(runId, 'archive', 'verifying', expected)
        await remote.checkDir(dir, rel, {
          signal,
          onProgress: (s) => this.report(runId, 'archive', 'verifying', expected, s, 'checks')
        })
        this.ledger.markBackedUp(files.map((f) => f.id))
      }
      // Past this point nothing can be cancelled: the remote copy is verified and the local delete is quick.
      this.report(runId, 'archive', 'removing', {}, undefined, undefined, true)
      this.ledger.setArchived(runId, new Date().toISOString())
      fs.rmSync(dir, { recursive: true, force: true })
    } finally {
      this.release(runId)
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
        const totalBytes = files.reduce((sum, f) => sum + f.sizeBytes, 0)
        const signal = this.active.get(runId)!.abort.signal
        const expected = { totalBytes, total: files.length }
        this.report(runId, 'restore', 'downloading', expected)
        await remote.download(runRemotePath(run.experimentId, runId), dir, {
          signal,
          onProgress: (s) => this.report(runId, 'restore', 'downloading', expected, s, 'transfers')
        })
        const missing = files.filter((f) => !fs.existsSync(this.ledger.filePath(f)))
        if (missing.length > 0)
          throw new Error(`Restore incomplete: ${missing.map((f) => f.filename).join(', ')} not found on the remote`)
      }
      this.ledger.setArchived(runId, null)
    } finally {
      this.release(runId)
    }
    this.onChange()
    return this.ledger.getRun(runId)
  }

  /** Stops an archive or restore that is still transferring; the run's files stay as they were. */
  cancel(runId: number): void {
    const entry = this.active.get(runId)
    if (entry && entry.progress.phase !== 'removing') entry.abort.abort()
  }

  /** Archives and restores running now, so a reloaded window can show them. */
  activeTransfers(): ArchiveProgress[] {
    return [...this.active.values()].map((e) => e.progress)
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
    const progress: ArchiveProgress = {
      runId,
      op: 'archive',
      phase: 'uploading',
      bytes: 0,
      totalBytes: 0,
      done: 0,
      total: 0,
      eta: null
    }
    this.active.set(runId, { progress, abort: new AbortController(), sentAt: 0 })
  }

  private release(runId: number) {
    this.busyRuns.delete(runId)
    this.active.delete(runId)
  }

  /**
   * Records where an archive/restore is and tells the window. `stats` are rclone's running totals; `count` picks
   * whether files done are its transfers or its checks. Updates are throttled except when the phase changes.
   */
  private report(
    runId: number,
    op: ArchiveProgress['op'],
    phase: ArchiveProgress['phase'],
    expected: { totalBytes?: number; total?: number },
    stats?: TransferStats,
    count?: 'transfers' | 'checks',
    force = false
  ) {
    const entry = this.active.get(runId)
    if (!entry) return
    const prev = entry.progress
    const next: ArchiveProgress = {
      runId,
      op,
      phase,
      bytes: stats?.bytes ?? 0,
      totalBytes: stats?.totalBytes || expected.totalBytes || 0,
      done: stats && count ? (count === 'checks' ? stats.checks : stats.transfers) : 0,
      total: (stats && count && (count === 'checks' ? stats.totalChecks : stats.totalTransfers)) || (expected.total ?? 0),
      eta: stats?.eta ?? null
    }
    entry.progress = next
    const now = Date.now()
    if (force || phase !== prev.phase || now - entry.sentAt >= PROGRESS_MS || !stats) {
      entry.sentAt = now
      this.onProgress(next)
    }
  }

  private requireRemote(): RemoteStore {
    const remote = this.getRemote()
    if (!remote) throw new Error('No remote configured. Set one in Settings (or LEDGER_RCLONE_REMOTE).')
    return remote
  }
}
