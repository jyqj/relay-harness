/**
 * Optional recursive filesystem watcher for the local provider.
 *
 * The watcher is a latency optimization only — correctness comes from the
 * tool-result invalidator and from every search's lazy freshness gate, both
 * of which diff the real tree regardless of whether events were observed.
 * When `fs.watch(root, { recursive: true })` cannot be established, the
 * provider degrades to touch-driven invalidation and reports the degraded
 * state through `status()` instead of failing composition.
 *
 * @module @relay-harness/rlh-code-index-local/watcher
 */

import { watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'

/** Debounce applied to native event storms; P1 needs no finer knob. */
export const WATCHER_EVENT_DEBOUNCE_MS = 1000

/** Lifecycle of the optional watcher surface. */
export type TreeWatcherState = 'off' | 'active' | 'degraded'

/**
 * Recursive tree watcher collapsing native change storms into debounced
 * triggers. Exclusively cooperative: it owns its handle, timer, and nothing
 * about the refresh pipeline beyond invoking one callback.
 */
export class TreeWatcher {
  private watcher: FSWatcher | undefined
  private timer: NodeJS.Timeout | undefined
  private stateValue: TreeWatcherState = 'off'

  constructor(
    private readonly root: string,
    private readonly onChange: () => void,
  ) {}

  /**
   * Establish the recursive watch.
   * @returns `'active'` when watching; `'degraded'` when the platform refused.
   */
  start(): Promise<TreeWatcherState> {
    try {
      this.watcher = watch(this.root, { recursive: true }, () => {
        this.schedule()
      })
      this.stateValue = 'active'
    } catch {
      // Recursive watches are unavailable on some platforms and fail outright
      // when the root vanishes; touch-driven invalidation remains authoritative.
      this.stateValue = 'degraded'
    }
    return Promise.resolve(this.stateValue)
  }

  /** Current lifecycle position, reported through provider status degradation. */
  get state(): TreeWatcherState {
    return this.stateValue
  }

  /** Stop watching and drop any pending trigger; safe to call repeatedly. */
  dispose(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.watcher?.close()
    this.watcher = undefined
    this.stateValue = 'off'
  }

  /**
   * Native-event entry point: register one more raw change. Bursts collapse
   * because any pending timer is replaced rather than queued.
   */
  schedule(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.onChange()
    }, WATCHER_EVENT_DEBOUNCE_MS)
  }
}
