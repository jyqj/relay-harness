/** Public long-term-memory value types shared by providers and consumers. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { CallId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Stable identity of one logical memory across append-only revisions. */
export type MemoryId = Branded<'MemoryId'>

/** Provider-owned identity of one prepared turn. */
export type MemoryTurnHandle = Branded<'MemoryTurnHandle'>

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
