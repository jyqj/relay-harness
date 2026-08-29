/** Outcome of one write attempt. */
export interface FileSaveResult {
  /** Whether the file now holds the text the write carried. */
  ok: boolean
}

/** Wiring for a `FileSaveCoordinator`. */
export interface FileSaveCoordinatorOptions {
  /** How long editing must pause before a write starts. */
  readonly debounceMs: number
  /** Writes the file; resolves once the write has succeeded or failed. */
  readonly persist: (contents: string) => Promise<FileSaveResult>
  /** Reports whether edits are still waiting to reach disk. */
  readonly onPendingChange: (pending: boolean) => void
  /** Reports the text a write confirmed, which is now on disk. */
  readonly onConfirmed: (contents: string) => void
}

/**
 * Debounced autosave for one open file. Edits coalesce into a single write,
 * only one write is in flight at a time, and text typed during a write is
 * saved after it — so the last edit always reaches disk, in order.
 */
export class FileSaveCoordinator {
  private timer: ReturnType<typeof setTimeout> | null = null
  private latestContents = ''
  private latestRevision = 0
  private lastChangeAt = 0
  private saving = false
  private disposed = false

  /**
   * @param options - debounce window, the write, and the progress callbacks.
   */
  constructor(private readonly options: FileSaveCoordinatorOptions) {}

  /**
   * Record the editor's current text and restart the debounce window.
   * @param contents - the editor's full text.
   */
  change(contents: string): void {
    this.latestContents = contents
    this.latestRevision += 1
    this.lastChangeAt = Date.now()
    this.options.onPendingChange(true)
    this.schedule(this.options.debounceMs)
  }

  /**
   * Stop debouncing and flush. Any edit not yet on disk is written
   * immediately, so closing a file does not lose the last keystrokes.
   */
  dispose(): void {
    this.disposed = true
    this.clearTimer()
    if (this.latestRevision > 0) void this.persistLatest()
  }

  private schedule(delay: number): void {
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      void this.persistLatest()
    }, delay)
  }

  private clearTimer(): void {
    if (this.timer === null) return
    clearTimeout(this.timer)
    this.timer = null
  }

  private async persistLatest(): Promise<void> {
    if (this.saving || this.latestRevision === 0) return

    this.saving = true
    const contents = this.latestContents
    const revision = this.latestRevision
    const result = await this.options.persist(contents)
    const succeeded = result.ok
    if (succeeded) {
      this.options.onConfirmed(contents)
    }

    this.saving = false
    if (revision === this.latestRevision) {
      if (succeeded) this.options.onPendingChange(false)
      return
    }

    const remainingDebounce = Math.max(
      0,
      this.options.debounceMs - (Date.now() - this.lastChangeAt),
    )
    if (this.disposed) {
      void this.persistLatest()
    } else {
      this.schedule(remainingDebounce)
    }
  }
}
