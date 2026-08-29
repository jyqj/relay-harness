/** Public long-term-memory value types shared by providers and consumers. */

import type { Branded } from '@relay-harness/rlh-brand'
import type { CallId, MessageId } from '@relay-harness/rlh-llm/brand'
import type { SessionId } from '@relay-harness/rlh-session/types'

/** Stable identity of one logical memory across append-only revisions. */
export type MemoryId = Branded<'MemoryId'>

/** Provider-owned identity of one prepared turn. */
export type MemoryTurnHandle = Branded<'MemoryTurnHandle'>

/** Stable identity of one durable automatic-extraction job. */
export type MemoryExtractionJobId = Branded<'MemoryExtractionJobId'>

/** Stable recall and write partition. Every operation addresses one exact scope. */
export interface MemoryScope {
  /** Stable workspace identity; callers may use a canonical local path. */
  readonly workspaceId: string
  /** Stable user identity inside the workspace. */
  readonly userId: string
  /** Stable agent identity shared by sessions that may recall one another. */
  readonly agentId: string
}

/** Semantic class with distinct write and expiry expectations. */
export type MemoryKind =
  | 'preference'
  | 'fact'
  | 'constraint'
  | 'decision'
  | 'procedure'
  | 'lesson'

/** Current governance state of a logical memory. */
export type MemoryStatus =
  | 'candidate'
  | 'active'
  | 'disputed'
  | 'superseded'
  | 'tombstoned'

/** Trust assigned from inspectable evidence rather than model confidence alone. */
export type MemoryTrust =
  | 'user-stated'
  | 'action-verified'
  | 'agent-proposed'
  | 'external'

/** Why the cited session events support a memory revision. */
export type MemoryVerification =
  | 'user-statement'
  | 'successful-tool-result'
  | 'agent-proposal'
  | 'external-observation'

/** Exact durable evidence behind one memory revision. */
export interface MemoryEvidence {
  /** Session containing the cited events. */
  readonly sessionId: SessionId
  /** Earlier event seqs whose immutable contents support the revision. */
  readonly eventSeqs: readonly number[]
  /** Verification performed before the provider accepted the revision. */
  readonly verification: MemoryVerification
  /** Optional tool call that produced action-verified evidence. */
  readonly callId?: CallId
  /** Exact source excerpt checked by the consumer. */
  readonly excerpt?: string
}

/** Current materialized view of one logical memory. */
export interface MemoryEntry {
  readonly id: MemoryId
  readonly revision: number
  readonly scope: MemoryScope
  readonly kind: MemoryKind
  readonly status: MemoryStatus
  readonly trust: MemoryTrust
  readonly content: string
  readonly summary?: string
  readonly importance: number
  readonly confidence: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly validUntil?: number
  readonly supersedes?: MemoryId
  readonly supersededBy?: MemoryId
  /** Human-readable reason retained by a tombstone revision. */
  readonly tombstoneReason?: string
  readonly evidence: readonly MemoryEvidence[]
  /** Committed injections into a model request; see `usefulAccessCount` for retrieval hits. */
  readonly accessCount: number
  /**
   * Legacy retrieval-hit counter retained for storage compatibility. It does not mean useful and
   * never affects ranking; explicit positive/negative {@link MemoryOutcome} observations do.
   */
  readonly usefulAccessCount: number
}

/** Ranked search result with provider-independent retrieval evidence. */
export interface MemorySearchHit {
  readonly entry: MemoryEntry
  readonly score: number
  readonly matchedBy: readonly string[]
}

/** One prepared recall candidate held until its host turn settles. */
export interface PreparedMemoryTurn {
  readonly handle: MemoryTurnHandle
  readonly scope: MemoryScope
  readonly sessionId: SessionId
  readonly turn: number
  readonly query: string
  readonly candidates: readonly MemorySearchHit[]
}

/** Direct user turn used to prepare a recall snapshot. */
export interface PrepareMemoryTurnInput {
  readonly scope: MemoryScope
  readonly sessionId: SessionId
  readonly turn: number
  readonly query: string
  readonly candidateLimit: number
}

/** Successful host settlement and the exact candidates made model-visible. */
export interface CommitMemoryTurnInput {
  readonly prepared: PreparedMemoryTurn
  readonly recalledMemoryIds: readonly MemoryId[]
  readonly assistantMessageId?: string
}

/** Failed or discarded host settlement. */
export interface AbortMemoryTurnInput {
  readonly prepared: PreparedMemoryTurn
  readonly reason: string
}

/** Provider write request after a consumer has inspected its evidence. */
export interface RememberMemoryInput {
  readonly scope: MemoryScope
  readonly kind: MemoryKind
  readonly content: string
  readonly summary?: string
  readonly importance: number
  readonly confidence: number
  readonly trust: MemoryTrust
  readonly status: 'candidate' | 'active' | 'disputed'
  readonly validUntil?: number
  readonly evidence: readonly MemoryEvidence[]
}

/** Append-only replacement of an existing logical memory. */
export interface ReviseMemoryInput {
  readonly scope: MemoryScope
  readonly id: MemoryId
  /** Optional compare-and-set guard; canonical providers reject a different current revision. */
  readonly expectedRevision?: number
  readonly content?: string
  readonly summary?: string | null
  readonly importance?: number
  readonly confidence?: number
  readonly trust?: MemoryTrust
  readonly status?: Exclude<MemoryStatus, 'tombstoned'>
  readonly validUntil?: number | null
  readonly evidence: readonly MemoryEvidence[]
  /** Optional user-review signal committed atomically with this revision. */
  readonly governance?: MemoryGovernanceSignalInput
}

/** Search request inside one exact scope. */
export interface SearchMemoryInput {
  readonly scope: MemoryScope
  readonly query: string
  readonly limit: number
  readonly kinds?: readonly MemoryKind[]
  readonly statuses?: readonly MemoryStatus[]
  /**
   * Whether the provider records retrieval-use accounting. Defaults to true. Auxiliary, unsent
   * context previews set false so merely enhancing a draft cannot mutate durable memory state.
   */
  readonly recordAccess?: boolean
}

/** Deterministic current-view listing inside one exact scope. */
export interface ListMemoryInput {
  readonly scope: MemoryScope
  /** Page size. Providers enforce their configured maximum. */
  readonly limit: number
  /** Zero-based stable page offset. Defaults to zero. */
  readonly offset?: number
  readonly kinds?: readonly MemoryKind[]
  readonly statuses?: readonly MemoryStatus[]
  /** Include entries whose `validUntil` has passed. Defaults to true for governance surfaces. */
  readonly includeExpired?: boolean
}

/** One stable page from the provider's materialized current-entry view. */
export interface MemoryListPage {
  readonly entries: readonly MemoryEntry[]
  readonly total: number
  readonly offset: number
  readonly hasMore: boolean
}

/** Append a tombstone for one existing memory. */
export interface ForgetMemoryInput {
  readonly scope: MemoryScope
  readonly id: MemoryId
  /** Optional compare-and-set guard; canonical providers reject a different current revision. */
  readonly expectedRevision?: number
  readonly reason: string
  readonly evidence: readonly MemoryEvidence[]
  /** Optional user-review signal committed atomically with this tombstone. */
  readonly governance?: MemoryGovernanceSignalInput
}

/** Canonical retrieval/governance signal kinds retained by the provider. */
export type MemorySignalKind =
  | 'candidate_hit'
  | 'injected'
  | 'user_confirmed'
  | 'user_rejected'

/** User review signal requested by an authorized governance Consumer. */
export interface MemoryGovernanceSignalInput {
  readonly kind: 'user_confirmed' | 'user_rejected'
  readonly sessionId: SessionId
  readonly eventSeqs: readonly number[]
}

/** One current signal row projected from the canonical provider. */
export interface MemorySignal {
  readonly id: string
  readonly memoryId: MemoryId
  readonly kind: MemorySignalKind
  readonly sessionId?: SessionId
  readonly turn?: number
  readonly eventSeqs: readonly number[]
  readonly createdAt: number
}

/** Deterministic or provider-enriched relationship found during review. */
export type MemoryConflictRelation =
  | 'exact-duplicate'
  | 'normalized-summary-collision'
  | 'semantic-conflict'

/** One inspectable conflict candidate; `semantic-conflict` is provider-attributed, never inferred as fact. */
export interface MemoryConflictCandidate {
  readonly entry: MemoryEntry
  readonly relation: MemoryConflictRelation
  readonly score: number
  readonly reasons: readonly string[]
  readonly detectorId: string
}

/** Exact-scope deterministic conflict lookup. */
export interface FindMemoryConflictsInput {
  readonly scope: MemoryScope
  readonly id: MemoryId
  readonly limit: number
}

/** Optional richer detector input after canonical deterministic candidates are known. */
export interface DetectMemoryConflictsInput {
  readonly target: MemoryEntry
  readonly candidates: readonly MemoryEntry[]
  readonly limit: number
}

/** Outcome impact used by ranking. Neutral observations remain inspectable but never boost recall. */
export type MemoryOutcomeImpact = 'positive' | 'negative' | 'neutral'

/** Durable sources the session outcome reconciler can prove without causal invention. */
export type MemoryOutcomeKind =
  | 'turn-completed'
  | 'turn-failed'
  | 'assistant-positive'
  | 'assistant-negative'
  | 'work-completed'
  | 'work-blocked'

/** One idempotent, session-derived outcome observation for an admitted memory. */
export interface MemoryOutcome {
  readonly id: string
  readonly memoryId: MemoryId
  readonly scope: MemoryScope
  readonly sessionId: SessionId
  readonly turn: number
  readonly kind: MemoryOutcomeKind
  readonly impact: MemoryOutcomeImpact
  readonly sourceEventSeqs: readonly number[]
  /** Optional durable sidecar/version reference when the source is not a Session event. */
  readonly sourceRef?: string
  readonly assistantMessageId?: MessageId
  readonly observedAt: number
}

/** Replace one reconciler-owned Session outcome set atomically. */
export interface ReconcileMemoryOutcomesInput {
  readonly scope: MemoryScope
  readonly sessionId: SessionId
  readonly outcomes: readonly MemoryOutcome[]
}

/** Scoped outcome history read. */
export interface ListMemoryOutcomesInput {
  readonly scope: MemoryScope
  readonly id: MemoryId
  readonly limit: number
}

/** Auxiliary LLM route captured for a restart-safe extraction job. */
export interface MemoryExtractionRoute {
  readonly provider: string
  readonly model: string
}

/** One bounded source item copied from a completed turn for extraction. */
export interface MemoryExtractionSource {
  readonly kind: 'user' | 'tool-result'
  readonly text: string
  readonly evidence: MemoryEvidence
  /** Tool name for a result source; absent for direct user messages. */
  readonly toolName?: string
}

/** Idempotent durable-job admission request. */
export interface EnqueueMemoryExtractionInput {
  /** Version of the deterministic extractor prompt and output schema. */
  readonly promptVersion: 1
  readonly scope: MemoryScope
  readonly sessionId: SessionId
  readonly turn: number
  readonly sourceHash: string
  readonly route: MemoryExtractionRoute
  readonly sources: readonly MemoryExtractionSource[]
  readonly maxAttempts: number
}

/** Durable extraction-job state. */
export type MemoryExtractionJobStatus = 'pending' | 'running' | 'completed' | 'failed'

/** Terminal extraction facts retained without storing raw model output. */
export interface MemoryExtractionResult {
  readonly memoryIds: readonly MemoryId[]
  readonly candidateCount: number
  readonly skippedCount: number
  readonly outputHash: string
}

/** One durable extraction job, including lease and retry state. */
export interface MemoryExtractionJob extends EnqueueMemoryExtractionInput {
  readonly id: MemoryExtractionJobId
  readonly status: MemoryExtractionJobStatus
  readonly attempts: number
  readonly availableAt: number
  readonly leaseOwner?: string
  readonly leaseUntil?: number
  readonly lastError?: string
  readonly result?: MemoryExtractionResult
  readonly createdAt: number
  readonly updatedAt: number
}

/** Atomic claim request for one available or expired-lease job. */
export interface ClaimMemoryExtractionInput {
  readonly workerId: string
  readonly leaseMs: number
  readonly now?: number
}

/** Successful settlement by the worker that owns the current lease. */
export interface CompleteMemoryExtractionInput {
  readonly jobId: MemoryExtractionJobId
  readonly workerId: string
  readonly result: MemoryExtractionResult
}

/** Failed attempt and retry schedule selected by the current lease owner. */
export interface FailMemoryExtractionInput {
  readonly jobId: MemoryExtractionJobId
  readonly workerId: string
  readonly error: string
  readonly retryAt: number
}
