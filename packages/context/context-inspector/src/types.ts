/** Client-safe Context Inspector projection vocabulary. */
import type {
  ContextCandidateDecision,
  ContextRetrievalPlan,
  CoverageRecord,
  Evidence,
} from '@relay-harness/rlh-context-engine/types'

/** Exact admitted user/message fact linked by a preparation trace. */
export interface ContextInspectorLinkedMessage {
  readonly seq: number
  readonly messageId: string
  readonly sourceKind: string
  readonly preview: string
}
/** Evidence enriched only with display path and why-used explanation. */
export interface ContextInspectorEvidence extends Evidence {
  readonly path?: string
  readonly whyUsed: readonly string[]
}
/** Contributor proposal and its admission/evidence/coverage facts. */
export interface ContextInspectorContribution {
  readonly contributorId: string
  readonly messageId: string
  readonly admitted: boolean
  readonly messageEventSeqs: readonly number[]
  readonly linkedMessages: readonly ContextInspectorLinkedMessage[]
  readonly evidence: readonly ContextInspectorEvidence[]
  readonly coverage?: CoverageRecord
}
/** One durable turn/step context preparation trace. */
export interface ContextInspectorTrace {
  readonly seq: number
  readonly turn: number
  readonly step: number
  readonly plan: ContextRetrievalPlan
  readonly decisions: readonly ContextCandidateDecision[]
  readonly contributions: readonly ContextInspectorContribution[]
  readonly admittedContributions: number
  readonly rejectedContributions: number
  readonly retrievalRejections: number
  readonly evidenceCount: number
}
/** Bounded whole-log projection delivered to the browser. */
export interface ContextInspectorProjection {
  readonly traces: readonly ContextInspectorTrace[]
  readonly omittedTraces: number
}

declare module '@relay-harness/rlh-session-projection/types' {
  interface SessionProjectionMap {
    /** Latest durable context/prepared traces with exact user/message admission links. */
    contextInspector: ContextInspectorProjection
  }
}
