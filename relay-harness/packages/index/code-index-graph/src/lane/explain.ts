/**
 * GraphExplain — explainability envelope for the graph enrichment read path,
 * ported from the reference implementation (`crates/cc-model/src/graph_explain.rs`).
 *
 * Reads that fail mid-enrichment degrade to partial results instead of failing
 * the search; the collector records every degradation so consumers can tell
 * "no graph context" apart from "graph context lost". The declared edge kinds
 * are static contract metadata and never make the envelope worth reporting —
 * clean runs stay empty (see {@link GraphExplainCollector.isEmpty}).
 *
 * @module @relay-harness/rlh-code-index-graph/lane/explain
 */

/** Entries kept in `readErrors`; further errors only bump the dropped count. */
export const GRAPH_EXPLAIN_MAX_READ_ERRORS = 8

/** Edge kinds the search enrichment declares it consults (the reference's `tool_graph_subsets::SEARCH_ENRICH`). */
export const SEARCH_ENRICH_EDGE_KINDS: readonly string[] = ['CALLS', 'REFERENCES', 'TESTS']

/**
 * Stable truncation tokens, ported verbatim from the reference's
 * `GraphExplain::truncated_reason` vocabulary; `db_error:<op>` is reserved for
 * walk paths that abort on a failed read.
 */
export type GraphTruncatedReason =
  | 'output_budget'
  | 'default_limit'
  | 'max_depth'
  | 'max_paths'
  | 'max_expansions'
  | 'max_nodes'
  | 'max_per_layer'
  | 'result_limit'
  | 'bridge_cap'
  | `db_error:${string}`

/** Finished envelope describing what degraded during one enrichment run. */
export interface GraphExplain {
  /** Edge kinds this surface declared it consults; static contract metadata, ignored by `isEmpty`. */
  readonly declared: readonly string[]
  /** Edge kinds actually traversed, deduplicated in first-seen order (the enrichment traverses none itself). */
  readonly edgeKindsUsed: readonly string[]
  /** Capped `"{op}: {error}"` messages for reads that failed but degraded to partial results. */
  readonly readErrors: readonly string[]
  /** Read errors beyond {@link GRAPH_EXPLAIN_MAX_READ_ERRORS} (count only). */
  readonly droppedReadErrorCount: number
  /** True when any budget clipped the result or a read degraded mid-run. */
  readonly truncated: boolean
  /** Stable token of the FIRST cause that clipped the result; first recording wins. */
  readonly truncatedReason?: string
  /** True when there is nothing to report beyond the static declaration. */
  readonly isEmpty: boolean
}

/** Incremental builder for {@link GraphExplain}; each degraded-but-usable fallback is recorded where it happens. */
export class GraphExplainCollector {
  private declared: readonly string[] = []
  private readonly edgeKindsUsed: string[] = []
  private readonly readErrors: string[] = []
  private droppedReadErrorCount = 0
  private truncated = false
  private truncatedReason: GraphTruncatedReason | undefined

  /**
   * Record the declared edge-kind subset. Replaces any previous declaration and
   * never affects {@link GraphExplainCollector.isEmpty}.
   * @param kinds - catalog kind names this surface consults (e.g. `CALLS`).
   */
  declareEdgeKinds(kinds: readonly string[]): void {
    this.declared = [...kinds]
  }

  /**
   * Note an edge kind actually traversed, deduplicated in first-seen order.
   * @param kind - dispatch token of the traversed kind.
   */
  noteEdgeKind(kind: string): void {
    if (!this.edgeKindsUsed.includes(kind)) {
      this.edgeKindsUsed.push(kind)
    }
  }

  /**
   * Record one failed read that degraded to a partial/empty result. Entries
   * beyond {@link GRAPH_EXPLAIN_MAX_READ_ERRORS} only bump the dropped count.
   * @param op - store operation that failed (e.g. `caller_rows_by_uids`).
   * @param error - the rejection, stringified into the entry.
   */
  recordReadError(op: string, error: unknown): void {
    if (this.readErrors.length < GRAPH_EXPLAIN_MAX_READ_ERRORS) {
      this.readErrors.push(`${op}: ${String(error)}`)
    } else {
      this.droppedReadErrorCount++
    }
  }

  /**
   * Mark the result truncated; the first recorded reason wins.
   * @param reason - stable token naming what clipped the result.
   */
  markTruncated(reason: GraphTruncatedReason): void {
    this.truncated = true
    if (this.truncatedReason === undefined) {
      this.truncatedReason = reason
    }
  }

  /**
   * Whether nothing beyond the static declaration is reported.
   * @returns true when no dynamic degradation was recorded.
   */
  isEmpty(): boolean {
    return this.edgeKindsUsed.length === 0
      && this.readErrors.length === 0
      && this.droppedReadErrorCount === 0
      && !this.truncated
  }

  /**
   * Freeze the accumulated state into the finished envelope.
   * @returns a snapshot whose arrays are copies; the collector stays usable.
   */
  finish(): GraphExplain {
    return {
      declared: [...this.declared],
      edgeKindsUsed: [...this.edgeKindsUsed],
      readErrors: [...this.readErrors],
      droppedReadErrorCount: this.droppedReadErrorCount,
      truncated: this.truncated,
      isEmpty: this.isEmpty(),
      ...(this.truncatedReason === undefined ? {} : { truncatedReason: this.truncatedReason }),
    }
  }
}
