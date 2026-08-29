/**
 * AgentLoop-owned materialization of an accepted context preparation into its durable trace.
 * @module rlh-agent-loop/context-trace
 */

import type {
  ContextPreparedEventData,
  PreparedStepContext,
} from '@relay-harness/rlh-context-engine'
import type { SessionEvent } from '@relay-harness/rlh-session'
import { isDeepStrictEqual } from 'node:util'

/** Compare complete identified messages, not ids alone: a pre-step listener may retain an id while rewriting content. */
function sameMessage(
  left: SessionEvent<'user/message'>['data'],
  right: SessionEvent<'user/message'>['data'],
): boolean {
  return isDeepStrictEqual(left, right)
}

/**
 * Bind prepared contributions to the exact user-message records admitted by `agent/pre-step`.
 *
 * @param prepared - attributed context returned by the optional ContextEngine.
 * @param entered - accepted user-message events already appended for this step.
 * @param position - owning turn and step.
 * @returns a detached durable trace payload in contributor order.
 */
export function materializeContextPrepared(
  prepared: PreparedStepContext,
  entered: readonly SessionEvent<'user/message'>[],
  position: { readonly turn: number; readonly step: number },
): ContextPreparedEventData {
  return {
    ...position,
    plan: prepared.plan,
    decisions: prepared.decisions,
    contributions: prepared.contributions.map(contribution => ({
      contributorId: contribution.contributorId,
      messageId: contribution.message.id,
      messageEventSeqs: entered
        .filter(event => sameMessage(event.data, contribution.message))
        .map(event => event.seq),
      evidence: contribution.evidence,
      ...contribution.coverage === undefined ? {} : { coverage: contribution.coverage },
    })),
  }
}
