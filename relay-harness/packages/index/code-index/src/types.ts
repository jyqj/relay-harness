/**
 * Vocabulary types for the local code-index capability. This module is types-only.
 *
 * @module @relay-harness/rlh-code-index/types
 */

/** Immutable snapshot of the index's two monotonic clocks, keyed by consumers for caching. */
export interface EpochPair {
  /** Advances exactly once per committed content-bearing write transaction. */
  readonly indexEpoch: number
  /** Reserved until semantic-evidence ingestion lands; implementations must not advance it. */
  readonly evidenceEpoch: number
}

/** Extraction tier that produced a chunk's symbol metadata (increasing confidence). */
export type ParserTier = 'semantic' | 'tree-sitter' | 'heuristic' | 'generic'

/** Adaptive repository-size class derived from the indexed file count. */
export type RepoSizeTier = 'tiny' | 'small' | 'medium' | 'large'

/** Model-shaped retrieval request against the local code index. */
export interface SearchRequest {
  /** Raw search text; interpreted as identifier/path tokens plus free words. */
  readonly query: string
  /** Restrict ranking to these exact file paths (explicit scope). */
  readonly paths?: readonly string[]
  /** Files the model recently worked with; boosts their preselect score. */
  readonly recentPaths?: readonly string[]
  /** Restrict candidates to file paths starting with this prefix. */
  readonly pathPrefix?: string
  /** Requested hit count; the engine caps it by the repository-size tier. */
  readonly topK?: number
}

/** One ranked chunk-level retrieval result. */
export interface SearchHit {
  /** Stable chunk identity (`chunk:<file>:<index>`). */
  readonly chunkId: string
  /** Workspace-relative file path backing this hit. */
  readonly filePath: string
  /** Inclusive start line of the indexed span (1-based). */
  readonly startLine: number
  /** Inclusive end line of the indexed span (1-based). */
  readonly endLine: number
  /** Enclosing declaration path from the parser, when known. */
  readonly breadcrumb?: string
  /** Nearest enclosing symbol name, when a parser produced symbols. */
  readonly symbolName?: string
  /** Final fused score after rerank; ties break on {@link SearchHit.chunkId}. */
  readonly score: number
  /** Connectivity score from graph enrichment (`0`-capped `0.4`); absent without graph context. */
  readonly graphScore?: number
  /** 1-based position in {@link SearchResult.hits}. */
  readonly rank: number
  /** Deterministic reason tokens explaining every additive score component. */
  readonly reasons: readonly string[]
  /** Parser tier that extracted this chunk's metadata. */
  readonly parserTier: ParserTier
  /** Confidence reported alongside {@link SearchHit.parserTier}. */
  readonly parserConfidence: number
}

/** Complete retrieval answer, including epoch pairing and degradation state. */
export interface SearchResult {
  /** Echoed request query. */
  readonly query: string
  /** Repository-size tier the engine resolved for this workspace. */
  readonly tier: RepoSizeTier
  /** Ranked hits in deterministic order (score desc, then chunkId asc). */
  readonly hits: readonly SearchHit[]
  /** Number of fused candidates considered before truncation to {@link SearchResult.hits}. */
  readonly candidateCount: number
  /** Epoch pair read at answer time; cache keys must include both values. */
  readonly epochs: EpochPair
  /** True when output was cut by an output budget rather than exhausted ranking. */
  readonly truncated: boolean
  /** True when any lane degraded (`readErrors` non-empty); callers must not cache. */
  readonly degraded: boolean
  /** Per-operation failure strings from lanes or readers that recovered partially. */
  readonly readErrors: readonly string[]
}

/** Why a refresh was started; part of status reporting and log-visible refresh summaries. */
export type RefreshReason = 'manual' | 'stale' | 'lazy'

/** Options accepted by `refresh`. */
export interface RefreshOptions {
  /** Caller-owned trigger classification. */
  readonly reason?: RefreshReason
  /** Drop the derived schema and rebuild from scratch instead of diffing. */
  readonly forceRebuild?: boolean
  /** Restrict this pass to explicit paths; omitted means the full tree. */
  readonly paths?: readonly string[]
}

/** Outcome of one completed refresh pass. */
export interface RefreshSummary {
  /** Trigger classification carried through from the options. */
  readonly reason: RefreshReason
  /** Files upserted with changed content. */
  readonly changedFiles: number
  /** Files removed from the index because they disappeared from disk. */
  readonly removedFiles: number
  /** Chunks written across all upserted files. */
  readonly chunksWritten: number
  /** Wall-clock duration of the whole pass in milliseconds. */
  readonly durationMs: number
  /** Epoch pair observed after the final commit. */
  readonly epochsAfter: EpochPair
}

/**
 * Which side of a call relation to walk for a `relations` graph explore.
 * `both` merges the two walks; each per-symbol cap still applies per side.
 */
export type GraphRelationDirection = 'callers' | 'callees' | 'both'

/** One symbol rendered as a node in a graph explore answer. */
export interface GraphNodeView {
  /** Provider-assigned node identity; stable for the answer's epoch pair. */
  readonly nodeId: string
  /** Symbol name as stored. */
  readonly name: string
  /** Symbol kind tag as stored (e.g. `function`, `method`, `class`). */
  readonly kind: string
  /** Workspace-relative file path declaring the symbol. */
  readonly filePath: string
  /** Inclusive start line of the symbol declaration (1-based). */
  readonly startLine: number
  /** Why the node is present (e.g. `target`, `caller`, `callee`, `test`); provider-defined. */
  readonly role?: string
}

/** One relation rendered as an edge in a graph explore answer. */
export interface GraphEdgeView {
  /** Provider-assigned edge identity; stable for the answer's epoch pair. */
  readonly edgeId: string
  /** Which derived relation the edge projects. */
  readonly kind: 'CALLS' | 'REFERENCES' | 'TESTS' | 'IMPORTS'
  /** {@link GraphNodeView.nodeId} of the edge's source end. */
  readonly source: string
  /** {@link GraphNodeView.nodeId} of the edge's target end. */
  readonly target: string
  /** Source line backing the edge, when the store recorded one. */
  readonly line?: number
  /** Call-site classification for `CALLS` edges (e.g. `direct`, `method`); provider-defined. */
  readonly callKind?: string
  /** Resolution strategy that bound the edge, when known; provider-defined. */
  readonly resolutionStrategy?: string
  /** Resolution confidence in `[0, 1]`; unresolved edges carry `0`. */
  readonly confidence: number
  /** Provider-authored explanation of why this edge exists. */
  readonly reason?: string
}

/** One derived test-to-code association surfaced by a graph explore. */
export interface GraphTestPairView {
  /** Test file that exercises {@link GraphTestPairView.codeFilePath}. */
  readonly testFilePath: string
  /** Code file exercised by the test. */
  readonly codeFilePath: string
  /** Provider-authored derivation reason (e.g. direct import, call-edge reachability). */
  readonly reason: string
  /** Association confidence in `[0, 1]`. */
  readonly confidence: number
}

/**
 * Self-describing provenance block on every graph explore answer: what the
 * operation declared it honored, which reads failed and were recovered, and
 * why output was cut, so consumers can judge trust without re-deriving it.
 */
export interface GraphExplainView {
  /** The limits and filters the answer declares it applied (deterministic tokens). */
  readonly declared: readonly string[]
  /** Per-operation failure strings from reads that recovered partially. */
  readonly readErrors: readonly string[]
  /** How many additional read errors were dropped after {@link GraphExplainView.readErrors} capped. */
  readonly droppedReadErrorCount: number
  /** Present only when `truncated` is true: which budget cut the answer. */
  readonly truncatedReason?: string
}

/** Model-shaped graph question against the derived code graph. */
export type GraphExploreRequest =
  | {
    /** Walk callers and/or callees of one symbol. */
    readonly op: 'relations'
    /** Symbol name to resolve; providers disambiguate with {@link GraphExploreRequest.filePath}. */
    readonly symbol: string
    /** Pin the symbol to this file when several declarations share the name. */
    readonly filePath?: string
    /** Which side to walk; defaults to provider policy when omitted. */
    readonly direction?: GraphRelationDirection
    /** Walk depth; this phase supports `1` and `2`. */
    readonly depth?: 1 | 2
    /** Requested node/edge cap; the tier's graph-enrich limits still bound the answer. */
    readonly max?: number
  }
  | {
    /** Reverse-reachability sweep answering "what breaks if this changes". */
    readonly op: 'impact'
    /** Symbol to sweep; omit when {@link GraphExploreRequest.files} pins the seeds instead. */
    readonly symbol?: string
    /** Files whose reverse dependencies join the sweep. */
    readonly files?: readonly string[]
    /** Whether impacted tests join the answer. */
    readonly includeTests?: boolean
    /** Requested cap before tier limits. */
    readonly max?: number
  }
  | {
    /** Map code files to the tests that exercise them. */
    readonly op: 'tests'
    /** Code files to map. */
    readonly files: readonly string[]
    /** Requested pair cap before tier limits. */
    readonly max?: number
  }
  | {
    /**
     * Detect circular dependency components over the file-import graph
     * (iterative Tarjan SCC; components of size 1 — including self-imports —
     * are not cycles and never surface).
     */
    readonly op: 'cycles'
    /**
     * Requested component cap. Components order by size descending before the
     * cap cuts, so truncation always keeps the largest cycles.
     */
    readonly max?: number
  }
  | {
    /** List symbols with no incoming callers and no external references. */
    readonly op: 'dead_code'
    /**
     * Requested item cap. The candidate scan runs a bounded superset
     * (`min(40 × cap, 5000)` symbols) before the cap cuts the answer.
     */
    readonly max?: number
  }

/** Severity bucket of one circular-dependency component, derived from its size. */
export type GraphCycleSeverity = 'low' | 'medium' | 'high' | 'critical'

/** One stored import edge proving two members of a cycle component are directly connected. */
export interface GraphCycleEdgeView {
  /** Importing (dependent) file; both ends are {@link GraphCycleComponentView.memberIds}. */
  readonly from: string
  /** Imported file inside the same component. */
  readonly to: string
  /** Import specifier as stored. */
  readonly importString: string
}

/** One circular-dependency component over the file-import graph. */
export interface GraphCycleComponentView {
  /** Provider-assigned identity (`cycle:<n>`); stable for the answer's epoch pair and render order. */
  readonly id: string
  /** Number of files bound into the component. */
  readonly size: number
  /** Severity bucket derived from {@link GraphCycleComponentView.size}. */
  readonly severity: GraphCycleSeverity
  /** Member file paths, sorted. */
  readonly memberIds: readonly string[]
  /** Stored import edges whose both endpoints are members — the cycle's witnesses. */
  readonly witnessEdges: readonly GraphCycleEdgeView[]
}

/** One symbol reported as likely dead code. */
export interface GraphDeadCodeView {
  /** Symbol name as stored. */
  readonly symbolName: string
  /** Store-global symbol identity. */
  readonly symbolId: string
  /** Workspace-relative file path declaring the symbol. */
  readonly filePath: string
  /** Symbol kind tag as stored. */
  readonly kind: string
  /** Why the symbol is reported dead; the current provider emits `no-callers`. */
  readonly reason: string
}

/** Complete graph explore answer, including epoch pairing and degradation state. */
export interface GraphExploreResult {
  /** Echoed {@link GraphExploreRequest.op}. */
  readonly op: GraphExploreRequest['op']
  /** Epoch pair read at answer time; cache keys must include both values. */
  readonly indexEpoch: EpochPair
  /** Nodes rendered for this answer; ids are unique within it. */
  readonly nodes: readonly GraphNodeView[]
  /** Edges rendered for this answer; both endpoints resolve inside {@link GraphExploreResult.nodes}. */
  readonly edges: readonly GraphEdgeView[]
  /** Test associations; present when the operation surfaces tests. */
  readonly tests?: readonly GraphTestPairView[]
  /** Circular-dependency components, largest first; present when the operation is `cycles`. */
  readonly cycles?: readonly GraphCycleComponentView[]
  /** Dead-code candidates; present when the operation is `dead_code`. */
  readonly deadCode?: readonly GraphDeadCodeView[]
  /** Provenance block; see {@link GraphExplainView}. */
  readonly explain: GraphExplainView
  /** True when an output budget cut the answer rather than exhausted the graph. */
  readonly truncated: boolean
  /** Number of graph candidates considered before truncation to the rendered fields. */
  readonly candidateCount: number
  /** Repository-size tier the answer resolved under; keys its graph-enrich limits. */
  readonly tier: RepoSizeTier
}

/** Per-tier caps for graph enrichment walks, ported verbatim from the reference implementation. */
export interface GraphEnrichLimits {
  /** Maximum symbols resolved from names per operation. */
  readonly maxResolve: number
  /** Maximum caller edges kept per resolved symbol. */
  readonly callersPerSym: number
  /** Maximum callee edges kept per resolved symbol. */
  readonly calleesPerSym: number
  /** Maximum test pairs kept per operation. */
  readonly maxTests: number
  /** Maximum route records kept per operation. */
  readonly maxRoutes: number
  /** Percentage of the operation's output budget the graph section may claim. */
  readonly graphBudgetPct: number
}

/** Model- and consumer-facing health report for the index. */
export interface IndexStatusReport {
  /** Number of files currently present in the index. */
  readonly indexedFileCount: number
  /** Repository-size tier derived from {@link IndexStatusReport.indexedFileCount}. */
  readonly tier: RepoSizeTier
  /** Current epoch pair. */
  readonly epochs: EpochPair
  /** Most recent completed refresh, or undefined before the first one. */
  readonly lastRefresh?: RefreshSummary
  /** True when a lane or reader failed during the last operation and results were partial. */
  readonly degraded: boolean
}
