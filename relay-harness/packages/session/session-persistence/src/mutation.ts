/** Ownership checks and optional cross-process exclusion for durable mutations. */
import type { SessionPersistenceFence } from '@relay-harness/rlh-session'

/**
 * Run a complete mutation under its exact proof, checking again after lock admission.
 * @param fence - captured owner; omission preserves unfenced backend behavior.
 * @param operation - mutation including its complete durability barrier.
 * @returns the mutation result after any exclusion interval ends.
 */
export async function runPersistenceMutation<T>(
  fence: SessionPersistenceFence | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const admitted = (): Promise<T> => {
    fence?.assertCurrent()
    return operation()
  }
  return fence?.runExclusive === undefined ? admitted() : fence.runExclusive(admitted)
}
