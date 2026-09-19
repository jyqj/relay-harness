/**
 * Per-execution relationship and recovery derivations over facts the existing
 * owners already publish: durable session headers, the subagent catalog's
 * descriptor classification, and in-process Job status. Nothing here creates
 * execution state or consults a lease store; a continuable descriptor proves
 * that a resume path exists, never that a lease is currently free.
 *
 * @module execution relationship and recovery derivation
 */

import type { SessionId, SessionOrigin } from '@relay-harness/rlh-session'
import type { WorkExecutionRecovery, WorkExecutionRelationship } from './types.ts'

/** Observed inputs for one entry's relationship edge toward the addressed Work. */
export interface RelationshipInput {
  /** Addressed Work session the view was read for. */
  readonly workSessionId: SessionId
  /** The execution entry's own session. */
  readonly sessionId: SessionId
  /** Durable direct-parent header edge, when one is recorded. */
  readonly parentSessionId?: SessionId
  /** Durable origin classification, when the header records one. */
  readonly origin?: SessionOrigin
  /** Durable subagent descriptor mode; defined only for a classified catalog child. */
  readonly mode?: 'one-shot' | 'continuable'
}

/**
 * Name the relationship edge between one execution and the addressed Work.
 * The root entry names its own origin edge when the Work itself was forked or
 * delegated; its identity as the Work's own execution stays carried by
 * `sessionId` matching the view's session.
 * @param input - observed header and descriptor facts for one entry.
 * @param controlLink - whether the Host currently holds this execution live.
 * @returns the edge with its peer and the separate control observation.
 */
export function executionRelationship(input: RelationshipInput, controlLink: boolean): WorkExecutionRelationship {
  if (input.sessionId !== input.workSessionId) {
    return {
      kind: input.mode === 'continuable' ? 'reports-to' : 'delegated',
      ...input.parentSessionId === undefined ? {} : { peerSessionId: input.parentSessionId },
      controlLink,
    }
  }
  if (input.origin === 'subagent') {
    return {
      kind: 'delegated',
      ...input.parentSessionId === undefined ? {} : { peerSessionId: input.parentSessionId },
      controlLink,
    }
  }
  if (input.parentSessionId !== undefined) {
    return { kind: 'forked-from', peerSessionId: input.parentSessionId, controlLink }
  }
  return { kind: 'owned', controlLink }
}

/** Observed inputs for one entry's recovery promises. */
export interface RecoveryInput {
  /** Which owner's evidence the entry draws from. */
  readonly evidence: 'session' | 'subagent' | 'job'
  /** Whether the Host currently holds this execution live. */
  readonly resident: boolean
  /** Durable origin classification; session and root entries only. */
  readonly origin?: SessionOrigin
  /** Durable subagent descriptor mode; defined only for a classified catalog child. */
  readonly mode?: 'one-shot' | 'continuable'
}

/**
 * Derive what recovery can honestly promise for one execution.
 * @param input - observed owner, residency, and descriptor facts.
 * @returns the conservative capability row: an unclassified child and a
 *   delegated-origin Work report `unknown` rather than any resume claim, a
 *   continuable descriptor reports the existing explicit resume path, a
 *   one-shot child and an in-process Job report `unavailable`, and Job history
 *   is `in-process` only — once the process is gone it is neither controllable
 *   nor readable here.
 */
export function executionRecovery(input: RecoveryInput): WorkExecutionRecovery {
  const control = input.resident ? 'resident' : 'none'
  if (input.evidence === 'job') return { history: 'in-process', resume: 'unavailable', control }
  if (input.evidence === 'subagent' && input.mode === undefined) {
    return { history: 'unknown', resume: 'unknown', control }
  }
  if (input.evidence === 'subagent') {
    return { history: 'persisted', resume: input.mode === 'continuable' ? 'explicit' : 'unavailable', control }
  }
  return {
    history: 'persisted',
    resume: input.origin === 'subagent' ? 'unknown' : 'explicit',
    control,
  }
}
