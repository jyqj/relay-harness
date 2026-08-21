/** Public long-term-memory value types shared by providers and consumers. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { CallId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

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
  readonly accessCount: number
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
  readonly content?: string
  readonly summary?: string | null
  readonly importance?: number
  readonly confidence?: number
  readonly trust?: MemoryTrust
  readonly status?: Exclude<MemoryStatus, 'tombstoned'>
  readonly validUntil?: number | null
  readonly evidence: readonly MemoryEvidence[]
}

/** Search request inside one exact scope. */
export interface SearchMemoryInput {
  readonly scope: MemoryScope
  readonly query: string
  readonly limit: number
  readonly kinds?: readonly MemoryKind[]
  readonly statuses?: readonly MemoryStatus[]
}

/** Append a tombstone for one existing memory. */
export interface ForgetMemoryInput {
  readonly scope: MemoryScope
  readonly id: MemoryId
  readonly reason: string
  readonly evidence: readonly MemoryEvidence[]
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
