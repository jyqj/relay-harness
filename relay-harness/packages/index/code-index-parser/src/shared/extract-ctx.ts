/**
 * Per-file extraction accumulator shared by the language walkers. Field
 * naming mirrors the reference implementation's `ExtractCtx`.
 * @module
 */

import type { CallEdgeRecord, ImportRecord, LiteralRecord, SymbolRecord } from '../types.ts'

/** A local export clause entry awaiting its symbol (`export { foo as bar }`). */
export interface PendingExport {
  /** Local binding name the export refers to. */
  readonly localName: string
  /** Exported name, or `null` for `export default <name>`. */
  readonly exportName: string | null
  /** True for `export default <name>`. */
  readonly isDefault: boolean
}

/**
 * Accumulator for one file's extraction. `currentSymbolUid` is the uid of the
 * declaration currently being traversed; walkers save it to a local before
 * overwriting and restore it after the declaration's subtree — by-value
 * save/restore, no stack.
 */
export class ExtractCtx {
  /** Extracted symbols, in source order. */
  readonly symbols: SymbolRecord[] = []
  /** Extracted import records, in source order. */
  readonly imports: ImportRecord[] = []
  /** AST-extracted call edges, in source order. */
  readonly callEdges: CallEdgeRecord[] = []
  /** Indexed literals, in source order. */
  readonly literals: LiteralRecord[] = []
  /** Export clauses awaiting symbol binding. */
  readonly pendingExports: PendingExport[] = []
  /**
   * Local binding name → its ES import record. Lets `applyPendingExports`
   * mark two-step forwarding (`import { x } from './b.ts'; export { x };`) as a
   * re-export.
   */
  readonly importBindings = new Map<string, ImportRecord>()
  /** Uid of the declaration currently being traversed. */
  currentSymbolUid: string | null = null
}
