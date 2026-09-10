/** Controllable connection source for product-shell tests. */
import type { ConnectionHandle } from '@relay-harness/rlh-api-remotes/client'

type Snapshot = ReturnType<ConnectionHandle['readiness']['getSnapshot']>

/** @returns an isolated readiness source with explicit transition control. */
export function connectionFixture() {
  let snapshot: Snapshot = { phase: 'ready', epoch: 1 }
  const listeners = new Set<() => void>()
  const source: ConnectionHandle['readiness'] = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  return {
    source, listeners,
    publish: (phase: Snapshot['phase'], epoch = snapshot.epoch) => {
      snapshot = { phase, epoch }
      for (const listener of listeners) listener()
    },
  }
}

/** Stable ready snapshot selector used by component props fixtures. */
export const useReadyConnection = ((select: (snapshot: Snapshot) => unknown) => select({ phase: 'ready', epoch: 1 })) as never
