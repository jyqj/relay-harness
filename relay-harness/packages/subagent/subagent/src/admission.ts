/**
 * Root-tree and direct-parent admission for subagent lifetimes. The controller
 * is transport-neutral: one-shot providers and continuable Activations acquire
 * the same leases, so alternate consumers cannot bypass deployment capacity.
 *
 * @module @relay-harness/rlh-subagent
 */

import type { Agent } from '@relay-harness/rlh-agent'
import type { SessionId } from '@relay-harness/rlh-session'
import { SubagentError } from './error.ts'

/** Capacity policy resolved at the SubagentRuntime config boundary. */
export interface SubagentAdmissionPolicy {
  /** Concurrent child lifetimes admitted below one root session. */
  readonly maxActivePerRoot?: number
  /** Concurrent direct children admitted below one parent Agent. */
  readonly maxActivePerParent?: number
  /** Whether a full scope rejects immediately or waits in its root-local queue. */
  readonly overflow: 'reject' | 'queue'
}

/** One admitted lifetime. Release is idempotent and may promote queued work. */
export interface SubagentAdmissionLease {
  /** Release the occupied root and parent capacity exactly once. */
  release(): void
}

/** One queued acquisition within a root-local fair queue. */
interface Waiter {
  readonly parentId: SessionId
  readonly signal: AbortSignal
  readonly resolve: (lease: SubagentAdmissionLease) => void
  readonly reject: (error: unknown) => void
  readonly onAbort: () => void
}

/** Mutable capacity owned by one root session tree. */
interface RootState {
  active: number
  readonly activeByParent: Map<SessionId, number>
  readonly queue: Waiter[]
}

const INERT_LEASE: SubagentAdmissionLease = Object.freeze({ release() {} })

/** Shared admission controller for every subagent execution surface. */
export class SubagentAdmissionController {
  private readonly roots = new Map<SessionId, RootState>()
  private closed = false

  /**
   * @param policy - validated deployment capacity and overflow behavior.
   * @param rootOf - synchronous root-session resolver for the live parent.
   */
  constructor(
    private readonly policy: SubagentAdmissionPolicy,
    private readonly rootOf: (parent: Agent) => SessionId,
  ) {}

  /**
   * Admit one subagent lifetime under the supplied live parent.
   * @param parent - direct parent whose root tree and sibling scope are charged.
   * @param signal - caller cancellation while admission is pending.
   * @returns an idempotent lease held until child-resource quiescence.
   */
  async acquire(parent: Agent, signal: AbortSignal): Promise<SubagentAdmissionLease> {
    signal.throwIfAborted()
    if (this.closed) throw this.drainingError()
    if (this.policy.maxActivePerRoot === undefined && this.policy.maxActivePerParent === undefined) {
      return INERT_LEASE
    }

    const rootId = this.rootOf(parent)
    const state = this.stateFor(rootId)
    if (this.hasCapacity(state, parent.id)) return this.grant(rootId, state, parent.id)
    if (this.policy.overflow === 'reject') {
      this.deleteIfEmpty(rootId, state)
      throw new SubagentError(this.capacityMessage(rootId, parent.id), 'CAPACITY_EXCEEDED')
    }

    return new Promise<SubagentAdmissionLease>((resolve, reject) => {
      const waiter: Waiter = {
        parentId: parent.id,
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = state.queue.indexOf(waiter)
          if (index >= 0) state.queue.splice(index, 1)
          this.deleteIfEmpty(rootId, state)
          // AbortSignal.reason is the platform's canonical cancellation value
          // and may be caller-defined rather than an Error.
          // oxlint-disable-next-line typescript/prefer-promise-reject-errors
          reject(signal.reason)
        },
      }
      signal.addEventListener('abort', waiter.onAbort, { once: true })
      state.queue.push(waiter)
      // Cancellation may have won between the entry check and listener install.
      if (signal.aborted) waiter.onAbort()
    })
  }

  /** Reject pending and future admissions without revoking published children. */
  close(): void {
    if (this.closed) return
    this.closed = true
    for (const [rootId, state] of this.roots) {
      for (const waiter of state.queue.splice(0)) {
        waiter.signal.removeEventListener('abort', waiter.onAbort)
        waiter.reject(this.drainingError())
      }
      this.deleteIfEmpty(rootId, state)
    }
  }

  /** Return or create one root-local capacity owner. */
  private stateFor(rootId: SessionId): RootState {
    const existing = this.roots.get(rootId)
    if (existing !== undefined) return existing
    const state: RootState = { active: 0, activeByParent: new Map(), queue: [] }
    this.roots.set(rootId, state)
    return state
  }

  /** Whether both the root and direct-parent ceilings admit another child. */
  private hasCapacity(state: RootState, parentId: SessionId): boolean {
    return (this.policy.maxActivePerRoot === undefined || state.active < this.policy.maxActivePerRoot)
      && (this.policy.maxActivePerParent === undefined
        || (state.activeByParent.get(parentId) ?? 0) < this.policy.maxActivePerParent)
  }

  /** Occupy capacity and return its one-shot release transaction. */
  private grant(rootId: SessionId, state: RootState, parentId: SessionId): SubagentAdmissionLease {
    state.active += 1
    state.activeByParent.set(parentId, (state.activeByParent.get(parentId) ?? 0) + 1)
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        state.active -= 1
        const parentActive = (state.activeByParent.get(parentId) as number) - 1
        if (parentActive === 0) state.activeByParent.delete(parentId)
        else state.activeByParent.set(parentId, parentActive)
        this.promote(rootId, state)
        this.deleteIfEmpty(rootId, state)
      },
    }
  }

  /** Promote the oldest currently eligible waiter until no capacity remains. */
  private promote(rootId: SessionId, state: RootState): void {
    while (!this.closed) {
      const index = state.queue.findIndex(waiter => !waiter.signal.aborted
        && this.hasCapacity(state, waiter.parentId))
      if (index < 0) return
      const waiter = state.queue[index] as Waiter
      state.queue.splice(index, 1)
      waiter.signal.removeEventListener('abort', waiter.onAbort)
      // Abort may win after selection but before the lease is published.
      if (waiter.signal.aborted) {
        waiter.reject(waiter.signal.reason)
        continue
      }
      waiter.resolve(this.grant(rootId, state, waiter.parentId))
    }
  }

  /** Remove a root state once it owns neither capacity nor pending work. */
  private deleteIfEmpty(rootId: SessionId, state: RootState): void {
    if (state.active === 0 && state.queue.length === 0) this.roots.delete(rootId)
  }

  /** Stable capacity rejection naming the saturated deployment scopes. */
  private capacityMessage(rootId: SessionId, parentId: SessionId): string {
    return `subagent capacity is full for root "${rootId}" or parent "${parentId}"`
  }

  /** Stable teardown rejection for pending and future work. */
  private drainingError(): SubagentError {
    return new SubagentError('subagent admission is closed; the operation was not admitted', 'DRAINING')
  }
}
