import { createSnapshotStore, type SnapshotStore } from '@relay-harness/rlh-client-runtime/client'
import type { SessionId } from '@relay-harness/rlh-client-connection/client'

/** Transient visibility state; layout persistence belongs to the Tree store. */
export interface SessionTreeOpenState {
  open: boolean
  anchorSessionId?: SessionId
}

/** Private coordinator shared by the root overlay and per-session header actions. */
export class SessionTreeController {
  /** Observable open state bound into the overlay's injected hook. */
  readonly state: SnapshotStore<SessionTreeOpenState> = createSnapshotStore({ open: false })

  /**
   * Open the Tree around one Session.
   * @param anchorSessionId - Session whose workspace family becomes visible.
   */
  open(anchorSessionId: SessionId): void {
    this.state.set({ open: true, anchorSessionId })
  }

  /** Close the Tree without discarding the last anchor. */
  close(): void {
    this.state.update((current) => { current.open = false })
  }
}
