/**
 * Provider-neutral long-term-memory capability.
 *
 * @module @deepseek-ai/dsh-memory
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type {
  AbortMemoryTurnInput,
  CommitMemoryTurnInput,
  ForgetMemoryInput,
  MemoryEntry,
  MemoryId as MemoryIdValue,
  MemoryScope,
  MemorySearchHit,
  MemoryTurnHandle as MemoryTurnHandleValue,
  PrepareMemoryTurnInput,
  PreparedMemoryTurn,
  RememberMemoryInput,
  ReviseMemoryInput,
  SearchMemoryInput,
} from './types.ts'

export type * from './types.ts'

/** Public type face paired with the runtime branding helper below. */
export type MemoryId = MemoryIdValue
/** Public type face paired with the runtime branding helper below. */
export type MemoryTurnHandle = MemoryTurnHandleValue

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

declare module '@deepseek-ai/cordis' {
  interface Context {
    longTermMemory: LongTermMemory
  }
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
   * Search current entries inside an exact scope.
   * @param input - normalized query, filters, and result cap.
   * @param signal - cancellation for the read.
   * @returns ranked current entries with retrieval-channel evidence.
   */
  abstract search(input: SearchMemoryInput, signal?: AbortSignal): Promise<readonly MemorySearchHit[]>
}

export default LongTermMemory
