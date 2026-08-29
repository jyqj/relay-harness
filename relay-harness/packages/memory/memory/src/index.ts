/**
 * Provider-neutral long-term-memory capability.
 *
 * @module @relay-harness/rlh-memory
 */

import { Context, Service } from '@relay-harness/cordis'
import type {
  AbortMemoryTurnInput,
  CommitMemoryTurnInput,
  ForgetMemoryInput,
  FindMemoryConflictsInput,
  DetectMemoryConflictsInput,
  ListMemoryInput,
  ListMemoryOutcomesInput,
  MemoryConflictCandidate,
  MemoryEntry,
  MemoryListPage,
  MemoryOutcome,
  MemorySignal,
  MemoryExtractionJobId as MemoryExtractionJobIdValue,
  MemoryId as MemoryIdValue,
  MemoryScope,
  MemorySearchHit,
  MemoryTurnHandle as MemoryTurnHandleValue,
  PrepareMemoryTurnInput,
  PreparedMemoryTurn,
  RememberMemoryInput,
  ReviseMemoryInput,
  ReconcileMemoryOutcomesInput,
  SearchMemoryInput,
} from './types.ts'

export type * from './types.ts'
export { MemoryExtractionQueue } from './extraction.ts'
export { default as MemoryExtractionQueueService } from './extraction.ts'
export { memoryContainsSecret, memoryExcludesDerivedTool } from './security.ts'

/** Public type face paired with the runtime branding helper below. */
export type MemoryId = MemoryIdValue
/** Public type face paired with the runtime branding helper below. */
export type MemoryTurnHandle = MemoryTurnHandleValue
/** Public type face paired with the runtime branding helper below. */
export type MemoryExtractionJobId = MemoryExtractionJobIdValue

/**
 * Brand one validated logical-memory identity.
 * @param value - provider-validated opaque identity.
 * @returns branded logical-memory identity.
 */
export const MemoryId = (value: string): MemoryIdValue => value as MemoryIdValue
/**
 * Brand one provider-owned prepared-turn identity.
 * @param value - provider-owned opaque identity.
 * @returns branded prepared-turn identity.
 */
export const MemoryTurnHandle = (value: string): MemoryTurnHandleValue => value as MemoryTurnHandleValue
/**
 * Brand one provider-owned extraction-job identity.
 * @param value - provider-owned opaque identity.
 * @returns branded extraction-job identity.
 */
export const MemoryExtractionJobId = (value: string): MemoryExtractionJobIdValue => value as MemoryExtractionJobIdValue

declare module '@relay-harness/cordis' {
  interface Context {
    longTermMemory: LongTermMemory
    memoryConflictDetector: MemoryConflictDetector
  }
}

/** Optional semantic detector composed by deployments that can justify richer conflict candidates. */
export abstract class MemoryConflictDetector extends Service {
  constructor(ctx: Context) {
    super(ctx, 'memoryConflictDetector')
  }

  /**
   * Detect provider-attributed semantic conflicts without mutating canonical memory.
   * @param input - target plus bounded same-Scope candidates.
   * @param signal - cancellation for optional provider work.
   * @returns attributed conflict candidates only.
   */
  abstract detect(
    input: DetectMemoryConflictsInput,
    signal?: AbortSignal,
  ): Promise<readonly MemoryConflictCandidate[]>
}

/** Service Definition for durable write governance and cross-session recall. */
export abstract class LongTermMemory extends Service {
  constructor(ctx: Context) {
    super(ctx, 'longTermMemory')
  }

  /**
   * Prepare one immutable recall observation before a host turn enters the log.
   * @param input - exact scope, host identity, query, and candidate cap.
   * @param signal - cancellation for the active host turn.
   * @returns provider handle and ranked candidates retained until settlement.
   */
  abstract prepare(input: PrepareMemoryTurnInput, signal: AbortSignal): Promise<PreparedMemoryTurn>

  /**
   * Commit the exact candidates made model-visible by a successful host turn.
   * @param input - prepared observation and admitted candidate identities.
   * @returns after the provider durably settles the prepared turn.
   */
  abstract commit(input: CommitMemoryTurnInput): Promise<void>

  /**
   * Abort a prepared turn that never reached a successful host settlement.
   * @param input - prepared observation and stable host-owned reason.
   * @returns after the provider durably settles the prepared turn.
   */
  abstract abort(input: AbortMemoryTurnInput): Promise<void>

  /**
   * Append the first revision of one governed memory.
   * @param input - scoped content, classification, trust, and durable evidence.
   * @param signal - cancellation for the write.
   * @returns the committed current entry.
   */
  abstract remember(input: RememberMemoryInput, signal?: AbortSignal): Promise<MemoryEntry>

  /**
   * Append a replacement revision without mutating prior evidence.
   * @param input - scoped identity, changed fields, and new evidence.
   * @param signal - cancellation for the write.
   * @returns the committed current entry.
   */
  abstract revise(input: ReviseMemoryInput, signal?: AbortSignal): Promise<MemoryEntry>

  /**
   * Append a tombstone and remove the entry from recall indexes.
   * @param input - scoped identity, reason, and durable evidence.
   * @param signal - cancellation for the write.
   * @returns the committed tombstoned entry.
   */
  abstract forget(input: ForgetMemoryInput, signal?: AbortSignal): Promise<MemoryEntry>

  /**
   * Read one current entry inside an exact scope.
   * @param scope - exact recall partition.
   * @param id - logical memory identity.
   * @param signal - cancellation for the read.
   * @returns current entry, or undefined when absent from this scope.
   */
  abstract read(scope: MemoryScope, id: MemoryId, signal?: AbortSignal): Promise<MemoryEntry | undefined>

  /**
   * List the provider's current materialized entries for one exact scope.
   * Unlike recall search, this governance read can include expired, superseded, and tombstoned
   * entries and never changes retrieval-use accounting.
   * @param input - exact scope, filters, and deterministic page window.
   * @param signal - cancellation for the read.
   * @returns one newest-first page and the matching total.
   */
  abstract list(input: ListMemoryInput, signal?: AbortSignal): Promise<MemoryListPage>

  /**
   * Find deterministic normalized-key conflicts in one exact scope.
   * @param input - target identity and result cap.
   * @param signal - cancellation for the read.
   * @returns duplicate or summary-collision candidates.
   */
  abstract findConflicts(
    input: FindMemoryConflictsInput,
    signal?: AbortSignal,
  ): Promise<readonly MemoryConflictCandidate[]>

  /**
   * Read canonical retrieval and user-governance signals.
   * @param scope - exact recall partition.
   * @param id - logical memory identity.
   * @param signal - cancellation for the read.
   * @returns chronological signal history.
   */
  abstract listSignals(scope: MemoryScope, id: MemoryId, signal?: AbortSignal): Promise<readonly MemorySignal[]>

  /**
   * Atomically replace one Session's reconciler-owned outcome observations.
   * @param input - exact scope, Session, and complete derived outcome set.
   * @param signal - cancellation before the write begins.
   * @returns after the canonical outcome view is durable.
   */
  abstract reconcileOutcomes(input: ReconcileMemoryOutcomesInput, signal?: AbortSignal): Promise<void>

  /**
   * Read recent outcome observations for one memory.
   * @param input - exact scope, identity, and result cap.
   * @param signal - cancellation for the read.
   * @returns newest-first outcome observations.
   */
  abstract listOutcomes(input: ListMemoryOutcomesInput, signal?: AbortSignal): Promise<readonly MemoryOutcome[]>

  /**
   * Search current entries inside an exact scope.
   * @param input - normalized query, filters, result cap, and optional access-accounting policy.
   * @param signal - cancellation for the read.
   * @returns ranked current entries with retrieval-channel evidence.
   */
  abstract search(input: SearchMemoryInput, signal?: AbortSignal): Promise<readonly MemorySearchHit[]>
}

export default LongTermMemory
