/**
 * Tool-result–triggered staleness invalidation.
 *
 * Every completed tool call may have touched the workspace, so each one
 * schedules a deferred stale pass; a burst of calls collapses into the last
 * scheduled trigger. The refresh pass itself is the single lifecycle owner
 * (`indexWorkspace` folds concurrent callers), so this module only decides
 * WHEN one starts and guarantees its timer never outlives the plugin.
 *
 * No path-level filtering is attempted: knowing which files a tool touched
 * would require trusting every tool's reporting, while a full diff over the
 * mtime+size fast path already costs almost nothing.
 *
 * @module @relay-harness/rlh-code-index-local/invalidate
 */

/** Delay after which settled tool activity becomes one refresh pass. */
export const DEFAULT_STALE_DEBOUNCE_MS = 500

/**
 * Collapse bursts of staleness triggers into one deferred call.
 *
 * Owns exactly one timer for exactly one trigger callback; `flushNow` gives
 * tests (and close-time quiescence) a deterministic route past the debounce
 * without waiting on real time.
 */
export class StaleInvalidator {
  private timer: NodeJS.Timeout | undefined
  private pendingPaths = new Set<string>()
  private fullRefreshPending = false
  private triggerPending = false

  constructor(
    private readonly debounceMs: number,
    private readonly trigger: (paths?: readonly string[]) => void,
  ) {}

  /**
   * Register another trigger; path scopes union across the debounce window.
   * @param paths - changed workspace-relative paths, or omitted to require a full refresh.
   */
  schedule(paths?: readonly string[]): void {
    this.triggerPending = true
    if (paths === undefined) this.fullRefreshPending = true
    else if (!this.fullRefreshPending) for (const path of paths) this.pendingPaths.add(path)
    this.cancelTimer()
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.fire()
    }, this.debounceMs)
  }

  /** Cancel any pending timer and run the trigger immediately. */
  flushNow(): void {
    this.cancelTimer()
    this.fire()
  }

  /** Whether a deferred trigger is still outstanding. */
  get pending(): boolean {
    return this.timer !== undefined
  }

  /** Stop the outstanding timer; idempotent, and safe during teardown. */
  dispose(): void {
    this.cancel()
  }

  private cancel(): void {
    this.cancelTimer()
    this.pendingPaths.clear()
    this.fullRefreshPending = false
    this.triggerPending = false
  }

  private cancelTimer(): void {
    if (this.timer === undefined) return
    clearTimeout(this.timer)
    this.timer = undefined
  }

  private fire(): void {
    const paths = !this.triggerPending || this.fullRefreshPending ? undefined : [...this.pendingPaths].sort()
    this.pendingPaths.clear()
    this.fullRefreshPending = false
    this.triggerPending = false
    this.trigger(paths)
  }
}

/**
 * Build the `session/event` callback that schedules stale passes on completed
 * tool calls and ignores every other event kind.
 * @param invalidator - the burst collapse owning the deferred trigger.
 * @returns the event handler to register on `session/event`.
 */
export function toolResultStaleHandler(
  invalidator: StaleInvalidator,
): (event: { readonly type: string }) => void {
  return (event): void => {
    if (event.type !== 'tool/result') return
    invalidator.schedule()
  }
}
