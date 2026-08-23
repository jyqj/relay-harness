/** Observable UI state for the issue automation operator overlay. */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { IssueOrchestrationSnapshot } from '@deepseek-ai/dsh-api-remotes/client'

/** Remote snapshot load and overlay visibility state. */
export interface IssueDashboardState {
  open: boolean
  loading: boolean
  snapshot?: IssueOrchestrationSnapshot
  error?: string
}

/** Stable observable controller shared by titlebar and overlay registrations. */
export class IssueDashboardController {
  /** Bare observable source bound to renderer-created hooks. */
  readonly state: SnapshotStore<IssueDashboardState> = createSnapshotStore({ open: false, loading: false })

  /** Open without discarding the last snapshot. */
  open(): void { this.state.update((current) => { current.open = true }) }
  /** Close without discarding the last snapshot. */
  close(): void { this.state.update((current) => { current.open = false }) }
  /** Mark a Remote read in progress and clear its prior error. */
  loading(): void { this.state.update((current) => { current.loading = true; delete current.error }) }
  /**
   * Publish a successful read.
   * @param snapshot Newly committed Remote snapshot.
   */
  loaded(snapshot: IssueOrchestrationSnapshot): void {
    this.state.set({ ...this.state.getSnapshot(), loading: false, snapshot })
  }
  /**
   * Publish a failed read.
   * @param error Human-readable Remote failure.
   */
  failed(error: string): void {
    this.state.update((current) => { current.loading = false; current.error = error })
  }
}
