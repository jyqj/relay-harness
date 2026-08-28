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

  constructor(
    private readonly debounceMs: number,
    private readonly trigger: () => void,
  ) {}

  /** Register another trigger; any pending one is replaced, not queued. */
  schedule(): void {
    this.cancel()
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.trigger()
    }, this.debounceMs)
  }

  /** Cancel any pending timer and run the trigger immediately. */
  flushNow(): void {
    this.cancel()
    this.trigger()
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
    if (this.timer === undefined) return
    clearTimeout(this.timer)
    this.timer = undefined
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
