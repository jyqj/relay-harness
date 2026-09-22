/** Scope readiness for actions over current-session Work facts. */
import type { ConnectionHandle } from '@relay-harness/rlh-api-remotes/client'
import type { ConversationSnapshot } from '@relay-harness/rlh-client-runtime/client'

/**
 * Separate unusable snapshots from a ready, possibly idle, Session.
 * @param connection - handshake/hydration snapshot, not a transport-success guess.
 * @param conversation - current Session history window.
 * @returns the reason actions can or cannot consume these Work facts.
 */
export function workAvailability(
  connection: ReturnType<ConnectionHandle['readiness']['getSnapshot']>,
  conversation: Pick<ConversationSnapshot, 'openState' | 'removed'> | undefined,
): 'ready' | 'disconnected' | 'synchronizing' | 'loading' | 'error' | 'removed' {
  if (connection.phase === 'error') return 'error'
  if (connection.phase === 'stopped' || connection.phase === 'reconnecting') return 'disconnected'
  if (connection.phase !== 'ready') return 'synchronizing'
  if (conversation?.removed === true) return 'removed'
  if (conversation?.openState === 'error') return 'error'
  if (conversation?.openState !== 'open') return 'loading'
  return 'ready'
}
