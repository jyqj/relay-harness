/** Host-only read face over ApiProxy-owned pending human interactions. */
import type { SessionId } from '@relay-harness/rlh-session'

/** Counts borrowed synchronously from the live proxy's authoritative request maps. */
export interface HostInteractions {
  /**
   * Count pending approval and question requests for one exact Session.
   * @param sessionId - owning Session identity.
   * @returns current pending counts, without consuming any request.
   */
  pendingFor(sessionId: SessionId): { approvals: number; questions: number }
}

declare module '@relay-harness/cordis' {
  interface Context { hostInteractions: HostInteractions }
}
