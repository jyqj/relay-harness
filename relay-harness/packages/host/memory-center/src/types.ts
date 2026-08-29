/** Client-safe wire vocabulary for the Memory Center Remote. */

import type {
  MemoryConflictRelation,
  MemoryEntry,
  MemoryKind,
  MemoryOutcome,
  MemorySignal,
  MemoryStatus,
  MemoryTrust,
} from '@relay-harness/rlh-memory/types'

/** Exact product scope; workspace identity matches AgentLoop's cwd-or-global partition. */
export interface MemoryCenterScope {
  readonly workspaceId: string
  /** Attached Host Session authorizing and selecting this workspace scope. */
  readonly sessionId: string
}

/** One durable model-admission occurrence for a memory Evidence record. */
export interface MemoryUsageOccurrence {
  readonly sessionId: string
  readonly turn: number
  readonly step: number
  readonly eventSeq: number
  readonly eventTime: number
  readonly evidenceId: string
  /** Revision admitted by this historical Context trace, when encoded by the provider. */
  readonly memoryRevision?: number
  /** Whether that admitted revision is still the entry's current revision. */
  readonly revisionState: 'current' | 'historical' | 'unknown'
}

/** Product row with expiry and usage facts derived without changing provider accounting. */
export interface MemoryCenterEntry {
  readonly entry: MemoryEntry
  readonly freshness: 'current' | 'expired'
  readonly whyUsed: readonly MemoryUsageOccurrence[]
}

/** Completeness of the non-activating Session Query usage scan. */
export interface MemoryUsageCoverage {
  readonly status: 'complete' | 'partial' | 'unavailable'
  readonly sessionsScanned: number
  readonly sessionsFailed: number
}

/** Filtered, deterministic Memory Center page. */
export interface MemoryCenterListRequest extends MemoryCenterScope {
  readonly query?: string
  readonly statuses?: readonly MemoryStatus[]
  readonly kinds?: readonly MemoryKind[]
  readonly includeExpired?: boolean
  readonly offset?: number
  readonly limit?: number
}

/** Explicit scoped governance search; includes states excluded from recall FTS. */
export interface MemoryCenterSearchRequest extends Omit<MemoryCenterListRequest, 'query'> {
  readonly query: string
}

/** One page plus the exact provider scope selected by Host configuration. */
export interface MemoryCenterSnapshot {
  readonly scope: {
    readonly workspaceId: string
    readonly userId: string
    readonly agentId: string
  }
  readonly entries: readonly MemoryCenterEntry[]
  readonly total: number
  readonly offset: number
  readonly hasMore: boolean
  readonly usageCoverage: MemoryUsageCoverage
}

/** Scoped entry read. */
export interface MemoryCenterReadRequest extends MemoryCenterScope {
  readonly id: string
}

/** Linked revision-chain comparison available from canonical supersession fields. */
export interface MemoryConflictComparison {
  readonly relation: 'supersedes' | 'superseded-by' | MemoryConflictRelation
  readonly entry: MemoryCenterEntry
  readonly score: number
  readonly reasons: readonly string[]
  readonly detectorId: string
}

/** Aggregate of outcome impacts that actually affect or explain ranking. */
export interface MemoryOutcomeSummary {
  readonly positive: number
  readonly negative: number
  readonly neutral: number
  readonly rankingAdjustment: number
}

/** Detail, evidence, and any provider-backed conflict comparison. */
export interface MemoryCenterDetail {
  readonly memory: MemoryCenterEntry
  readonly conflicts: readonly MemoryConflictComparison[]
  readonly signals: readonly MemorySignal[]
  readonly outcomes: readonly MemoryOutcome[]
  readonly outcomeSummary: MemoryOutcomeSummary
  readonly outcomeCoverage: 'complete' | 'unavailable'
  readonly usageCoverage: MemoryUsageCoverage
}

/** Governance mutation anchored in an attached session event. */
export interface MemoryCenterMutationRequest {
  readonly sessionId: string
  readonly id: string
  /** Revision displayed when the user initiated this governance action. */
  readonly expectedRevision: number
}

/** Reject a candidate/disputed memory with an auditable user reason. */
export interface MemoryCenterRejectRequest extends MemoryCenterMutationRequest {
  readonly reason: string
}

/** User-authored replacement fields for one non-terminal memory. */
export interface MemoryCenterReviseRequest extends MemoryCenterMutationRequest {
  readonly content?: string
  readonly summary?: string | null
  readonly importance?: number
  readonly confidence?: number
  readonly status?: Exclude<MemoryStatus, 'tombstoned' | 'superseded'>
  readonly validUntil?: number | null
}

/** Tombstone one memory with an auditable user reason. */
export interface MemoryCenterDeleteRequest extends MemoryCenterMutationRequest {
  readonly reason: string
}

/** Stable user-governance action recorded before the provider mutation. */
export type MemoryGovernanceAction = 'approve' | 'reject' | 'revise' | 'tombstone'

/** Informational request fact used as exact evidence by a successful provider revision. */
export interface MemoryGovernanceRequestedEventData {
  readonly memoryId: string
  readonly action: MemoryGovernanceAction
  readonly workspaceId: string
  readonly excerpt: string
}

/** Trust selected after an explicit user governance action. */
export type MemoryCenterGovernedTrust = Extract<MemoryTrust, 'user-stated'>
