/**
 * Pure answer assembly for the seam's `exploreGraph` verb: the `relations`,
 * `impact`, and `tests` questions projected onto the graph read facet's
 * batched reads, plus the dispatch table the `cycles` and `dead_code`
 * analysis ops (in their own modules) hang off. All reads are synchronous
 * facet calls — the provider wraps this module with the lazy-index guarantee,
 * tier resolution, and epoch pairing, so nothing here touches fs, clocks, or
 * SQL.
 *
 * Contracts shared by every op:
 * - Directions follow the port's seed-side naming: callers of a symbol read
 *   through `calleeRowsByUids` (rows where it is the callee) and vice versa,
 *   mirroring the enrichment path's mapping.
 * - Per-seed edge windows reuse the tier's enrichment caps (`callersPerSym` /
 *   `calleesPerSym`); a request's `max` is a GLOBAL rendered-node cap, not a
 *   default — without it the per-seed windows stay the only bound.
 * - Truncation tokens reuse the graph package's stable vocabulary: `max_nodes`
 *   when the node cap clips targets or edge endpoints, `result_limit` when a
 *   test-pair, cycle-component, or dead-code list is cut. First cause wins.
 * - A `relations` (or symbol-seeded `impact`) target that resolves to no
 *   symbol is a degradation, not an error: the answer comes back empty with a
 *   `symbol_not_found: <name>` entry in `explain.readErrors` and `truncated`
 *   stays false (nothing was cut by a budget). Store failures are NOT
 *   recovered here — they propagate, and the tool consumer reports them as
 *   structured failures; `readErrors` therefore only ever carries these
 *   provider-authored degradation tokens.
 * - Edge `confidence` derives from the stored resolution kind via the
 *   resolver's default-confidence table (`0` when absent or unknown), matching
 *   enrichment; the edge projection's stored `resolutionStrategy` rides
 *   through verbatim when present.
 *
 * @module @relay-harness/rlh-code-index-local/explore
 */

import type {
  EpochPair,
  GraphEdgeView,
  GraphExploreRequest,
  GraphExploreResult,
  GraphEnrichLimits,
  GraphExplainView,
  GraphNodeView,
  GraphTestPairView,
  RepoSizeTier,
} from '@relay-harness/rlh-code-index'
import { defaultResolutionConfidence, type ResolutionKind } from '@relay-harness/rlh-code-index-graph'
import { compareStrings } from '@relay-harness/rlh-code-index-search'
import type { CallerEdgeRow, GraphReadFacet, SymbolRowLite } from '@relay-harness/rlh-code-index-search'
import { cyclesAnswer } from './cycles.ts'
import { deadCodeAnswer } from './dead-code.ts'

/** Declared edge kinds for the `relations` op: the call graph only. */
export const RELATIONS_DECLARED: readonly string[] = ['CALLS']

/** Declared edge kinds for the `impact` op: the caller walk plus test associations. */
export const IMPACT_DECLARED: readonly string[] = ['CALLS', 'TESTS']

/** Declared edge kinds for the `tests` op: test associations only. */
export const TESTS_DECLARED: readonly string[] = ['TESTS']

/** Stable token recorded when the rendered-node cap clips an answer. */
export const TRUNCATED_MAX_NODES = 'max_nodes'

/** Stable token recorded when a test-pair list is cut to its cap. */
export const TRUNCATED_RESULT_LIMIT = 'result_limit'

/** `explain.readErrors` prefix for a `relations`/`impact` symbol that resolved to no declaration. */
export const SYMBOL_NOT_FOUND_PREFIX = 'symbol_not_found'

/** Resolution kinds the default-confidence table maps; anything else counts as unresolved. */
const KNOWN_RESOLUTION_KINDS: ReadonlySet<string> = new Set(['exact', 'qualified', 'scope_resolved', 'heuristic', 'unresolved'])

/** A symbol row whose uid is known — the only rows that can back a node. */
interface UidSymbolRow extends SymbolRowLite {
  readonly symbolUid: string
}

/** Everything one explore answer needs: the question, the facet, and the resolved tier context. */
export interface ExploreGraphInput {
  /** The model-shaped graph question. */
  readonly request: GraphExploreRequest
  /** Read-only graph face of the admitted store. */
  readonly facet: GraphReadFacet
  /** Tier enrichment caps supplying the per-seed edge windows and the test-pair cap. */
  readonly limits: Readonly<GraphEnrichLimits>
  /** Repository-size tier the answer resolves under. */
  readonly tier: RepoSizeTier
  /** Epoch pair observed at answer time. */
  readonly epochs: EpochPair
}

/**
 * Edge confidence from the stored resolution kind, matching enrichment's
 * derivation (`0` when the kind is absent or unknown).
 * @param kind - resolution kind as stored on the edge row.
 * @returns the kind's default confidence in `[0, 1]`.
 */
export function edgeConfidenceOf(kind: string | null): number {
  return kind !== null && KNOWN_RESOLUTION_KINDS.has(kind)
    ? defaultResolutionConfidence(kind as ResolutionKind)
    : 0
}

/**
 * Mutable rendered-node table with the answer's global cap. Insertion order is
 * render order (targets first, then edge endpoints as encountered), and the
 * first role a uid is added under wins.
 */
class NodeTable {
  private readonly rows = new Map<string, GraphNodeView>()
  /** Set once an add was refused because the cap was already full. */
  clipped = false

  constructor(private readonly cap: number) {}

  has(nodeId: string): boolean {
    return this.rows.has(nodeId)
  }

  values(): GraphNodeView[] {
    return [...this.rows.values()]
  }

  /**
   * Add one uid-backed symbol row under a role, unless the cap is already full.
   * @param row - the symbol's lite row; callers resolve the uid first.
   * @param role - why the node is present (`target`, `caller`, or `callee`).
   * @returns false when the cap refused the add.
   */
  add(row: UidSymbolRow, role: string): boolean {
    if (this.rows.size >= this.cap) {
      this.clipped = true
      return false
    }
    this.rows.set(row.symbolUid, {
      nodeId: row.symbolUid,
      name: row.name,
      kind: row.kind,
      filePath: row.filePath,
      startLine: row.startLine,
      role,
    })
    return true
  }
}

/**
 * Resolve a `relations`/`impact` symbol to its declaration rows: an explicit
 * file path pins the lookup to that file's symbols, otherwise the store's
 * exact-name index answers. Rows without a uid are dropped — they cannot back
 * a node id.
 * @param facet - the graph read facet.
 * @param symbol - symbol name to resolve.
 * @param filePath - optional file pin when several declarations share the name.
 * @param limit - resolution cap (the tier's `maxResolve`).
 * @returns the resolved rows in store order.
 */
function resolveTargetRows(
  facet: GraphReadFacet,
  symbol: string,
  filePath: string | undefined,
  limit: number,
): readonly UidSymbolRow[] {
  const found = filePath === undefined
    ? facet.symbolUidsByExactNames([symbol], limit)
    : facet.symbolsByFilePaths([filePath]).filter(row => row.name === symbol)
  return found.filter((row): row is UidSymbolRow => row.symbolUid !== null).slice(0, limit)
}

/** One deduplicated call edge plus the neighbor side it was reached through. */
interface WalkedEdge {
  /** The stored edge row; both endpoint uids are non-empty. */
  readonly row: CallerEdgeRow
  /** uid of the far endpoint relative to the seed side this row was read from. */
  readonly neighborUid: string
}

/** Stable identity of one stored call edge, independent of the read direction. */
function edgeKey(row: CallerEdgeRow): string {
  return `${row.callerSymbolUid as string}>${row.calleeSymbolUid as string}@${row.filePath}:${row.line ?? 0}`
}

/** Collect the caller-side walk rows for a frontier: rows where the seeds are the callees. */
function readCallerEdges(
  facet: GraphReadFacet,
  frontier: readonly string[],
  limits: Readonly<GraphEnrichLimits>,
): readonly CallerEdgeRow[] {
  return facet.calleeRowsByUids(frontier, limits.callersPerSym)
}

/** Collect the callee-side walk rows for a frontier: rows where the seeds are the callers. */
function readCalleeEdges(
  facet: GraphReadFacet,
  frontier: readonly string[],
  limits: Readonly<GraphEnrichLimits>,
): readonly CallerEdgeRow[] {
  return facet.callerRowsByUids(frontier, limits.calleesPerSym)
}

/**
 * Walk `depth` hops of call edges from a frontier, callers and/or callees per
 * the direction. Caller-side rows are read before callee-side rows per hop,
 * edges deduplicate by stored identity, and the next frontier is the neighbor
 * sides actually reached. Incomplete rows (either endpoint uid missing) drop
 * before deduplication.
 * @returns the distinct walked edges in deterministic collection order.
 */
function walkRelationEdges(
  facet: GraphReadFacet,
  limits: Readonly<GraphEnrichLimits>,
  direction: 'callers' | 'callees' | 'both',
  depth: 1 | 2,
  targetUids: readonly string[],
): readonly WalkedEdge[] {
  const walkCallers = direction !== 'callees'
  const walkCallees = direction !== 'callers'
  const byKey = new Map<string, WalkedEdge>()
  let frontier = targetUids
  for (let hop = 1; hop <= depth; hop += 1) {
    const nextFrontier: string[] = []
    const reads: ReadonlyArray<{ rows: readonly CallerEdgeRow[]; neighborOf: (row: CallerEdgeRow) => string | null }> = [
      ...(walkCallers ? [{ rows: readCallerEdges(facet, frontier, limits), neighborOf: (row: CallerEdgeRow) => row.callerSymbolUid }] : []),
      ...(walkCallees ? [{ rows: readCalleeEdges(facet, frontier, limits), neighborOf: (row: CallerEdgeRow) => row.calleeSymbolUid }] : []),
    ]
    for (const { rows, neighborOf } of reads) {
      for (const row of rows) {
        const callerUid = row.callerSymbolUid
        const calleeUid = row.calleeSymbolUid
        const neighborUid = neighborOf(row)
        if (callerUid === null || callerUid === '' || calleeUid === null || calleeUid === '' || neighborUid === null || neighborUid === '') continue
        const key = edgeKey(row)
        if (byKey.has(key)) continue
        byKey.set(key, { row, neighborUid })
        if (hop < depth) nextFrontier.push(neighborUid)
      }
    }
    frontier = [...new Set(nextFrontier)]
    if (frontier.length === 0) break
  }
  return [...byKey.values()]
}

/**
 * Render walked edges over a node table: each edge's endpoints enter as
 * `caller`/`callee` nodes (present nodes keep their first role), and the first
 * refused add stops rendering — remaining edges stay unrendered and the table
 * reports the clip.
 * @param walked - the distinct walked edges in render order.
 * @param nodes - the answer's node table (targets already added).
 * @param rowByUid - symbol rows backing every endpoint uid.
 * @returns the rendered edges.
 */
function renderEdges(
  walked: readonly WalkedEdge[],
  nodes: NodeTable,
  rowByUid: ReadonlyMap<string, UidSymbolRow>,
): GraphEdgeView[] {
  const edges: GraphEdgeView[] = []
  for (const { row } of walked) {
    const callerUid = row.callerSymbolUid as string
    const calleeUid = row.calleeSymbolUid as string
    const callerRow = rowByUid.get(callerUid)
    const calleeRow = rowByUid.get(calleeUid)
    if (callerRow === undefined || calleeRow === undefined) continue
    if (!nodes.has(callerUid) && !nodes.add(callerRow, 'caller')) break
    if (!nodes.has(calleeUid) && !nodes.add(calleeRow, 'callee')) break
    edges.push({
      edgeId: `edge:${edges.length + 1}`,
      kind: 'CALLS',
      source: callerUid,
      target: calleeUid,
      ...(row.line === null ? {} : { line: row.line }),
      ...(row.callKind === null ? {} : { callKind: row.callKind }),
      ...(row.resolutionStrategy == null || row.resolutionStrategy === '' ? {} : { resolutionStrategy: row.resolutionStrategy }),
      confidence: edgeConfidenceOf(row.resolutionKind),
      reason: `${row.filePath}:${row.line ?? 0}`,
    })
  }
  return edges
}

/** Assemble the explain envelope; `truncatedReason` rides only when set. */
function explainOf(declared: readonly string[], readErrors: readonly string[], truncatedReason: string | undefined): GraphExplainView {
  return {
    declared,
    readErrors,
    droppedReadErrorCount: 0,
    ...(truncatedReason === undefined ? {} : { truncatedReason }),
  }
}

/**
 * Shared tail of every answer: freeze the collected views into the seam
 * shape. The analysis ops (`cycles`, `dead_code`) call it with empty
 * node/edge/test views and spread their dedicated arrays on top.
 * @param input - the question plus the resolved tier context.
 * @param op - the answered operation.
 * @param declared - edge kinds the answer declares it honored.
 * @param nodes - rendered nodes.
 * @param edges - rendered edges.
 * @param tests - rendered test pairs, when the op surfaces tests.
 * @param readErrors - provider-authored degradation tokens.
 * @param truncatedReason - stable truncation token, when a budget cut the answer.
 * @param candidateCount - candidates considered before truncation.
 * @returns the explain-bearing answer without the analysis arrays.
 */
export function finishAnswer(
  input: ExploreGraphInput,
  op: GraphExploreRequest['op'],
  declared: readonly string[],
  nodes: readonly GraphNodeView[],
  edges: readonly GraphEdgeView[],
  tests: readonly GraphTestPairView[] | undefined,
  readErrors: readonly string[],
  truncatedReason: string | undefined,
  candidateCount: number,
): GraphExploreResult {
  return {
    op,
    indexEpoch: input.epochs,
    nodes,
    edges,
    ...(tests === undefined ? {} : { tests }),
    explain: explainOf(declared, readErrors, truncatedReason),
    truncated: truncatedReason !== undefined,
    candidateCount,
    tier: input.tier,
  }
}

/** Answer the `relations` op: callers and/or callees of one symbol, one or two hops. */
function relationsAnswer(input: ExploreGraphInput, request: Extract<GraphExploreRequest, { op: 'relations' }>): GraphExploreResult {
  const { facet, limits } = input
  const targets = resolveTargetRows(facet, request.symbol, request.filePath, limits.maxResolve)
  if (targets.length === 0) {
    return finishAnswer(input, 'relations', RELATIONS_DECLARED, [], [], undefined, [`${SYMBOL_NOT_FOUND_PREFIX}: ${request.symbol}`], undefined, 0)
  }
  const targetUids = targets.map(row => row.symbolUid)
  const nodes = new NodeTable(request.max ?? Number.POSITIVE_INFINITY)
  for (const row of targets) nodes.add(row, 'target')

  const walked = walkRelationEdges(facet, limits, request.direction ?? 'both', request.depth ?? 1, targetUids)
  const endpointUids = walked.flatMap(({ row }) => [row.callerSymbolUid as string, row.calleeSymbolUid as string])
  const endpointRows = facet.symbolRowsByUids([...targetUids, ...endpointUids])
  const rowByUid = new Map<string, UidSymbolRow>(endpointRows.map(row => [row.symbolUid as string, row as UidSymbolRow]))
  const edges = renderEdges(walked, nodes, rowByUid)
  const reason = nodes.clipped ? TRUNCATED_MAX_NODES : undefined
  return finishAnswer(input, 'relations', RELATIONS_DECLARED, nodes.values(), edges, undefined, [], reason, walked.length)
}

/** Answer the `impact` op: reverse-reachability sweep from seed files plus optional test pairs. */
function impactAnswer(input: ExploreGraphInput, request: Extract<GraphExploreRequest, { op: 'impact' }>): GraphExploreResult {
  const { facet, limits } = input
  if (request.symbol === undefined && request.files === undefined) {
    throw new Error('impact explore requires a symbol or at least one file')
  }
  const readErrors: string[] = []
  const seedFiles = new Set<string>(request.files ?? [])
  if (request.symbol !== undefined) {
    const targets = resolveTargetRows(facet, request.symbol, undefined, limits.maxResolve)
    if (targets.length === 0) readErrors.push(`${SYMBOL_NOT_FOUND_PREFIX}: ${request.symbol}`)
    for (const row of targets) seedFiles.add(row.filePath)
  }
  // Seed nodes are every symbol declared in the seed files; a symbol-resolved
  // target's declaration lives in its own file, so the file read covers it.
  const seedRows = facet.symbolsByFilePaths([...seedFiles].sort()).filter((row): row is UidSymbolRow => row.symbolUid !== null)
  const seedUids = seedRows.map(row => row.symbolUid)

  const nodes = new NodeTable(request.max ?? Number.POSITIVE_INFINITY)
  for (const row of seedRows) nodes.add(row, 'target')
  const walked = walkRelationEdges(facet, limits, 'callers', 1, seedUids)
  const walkedUids = walked.flatMap(({ row }) => [row.callerSymbolUid as string, row.calleeSymbolUid as string])
  const walkedRows = facet.symbolRowsByUids(walkedUids)
  const rowByUid = new Map<string, UidSymbolRow>(walkedRows.map(row => [row.symbolUid as string, row as UidSymbolRow]))
  const edges = renderEdges(walked, nodes, rowByUid)

  let truncatedReason = nodes.clipped ? TRUNCATED_MAX_NODES : undefined
  let tests: readonly GraphTestPairView[] | undefined
  if (request.includeTests !== false) {
    const pairs = facet.findImpactedTests([...seedFiles].sort())
      .map(row => ({ testFilePath: row.testFilePath, codeFilePath: row.codeFilePath, reason: row.reason, confidence: row.confidence }))
      .sort((left, right) => (left.testFilePath !== right.testFilePath
        ? compareStrings(left.testFilePath, right.testFilePath)
        : compareStrings(left.codeFilePath, right.codeFilePath)))
    tests = pairs.slice(0, limits.maxTests)
    if (pairs.length > tests.length) {
      truncatedReason ??= TRUNCATED_RESULT_LIMIT
    }
  }
  return finishAnswer(input, 'impact', IMPACT_DECLARED, nodes.values(), edges, tests, readErrors, truncatedReason, walked.length)
}

/** Answer the `tests` op: map code files to the test pairs that exercise them. */
function testsAnswer(input: ExploreGraphInput, request: Extract<GraphExploreRequest, { op: 'tests' }>): GraphExploreResult {
  const { facet, limits } = input
  // The seam type requires `files`; the guard serves out-of-contract runtime
  // callers, failing loud instead of surfacing a raw TypeError.
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- see above; the union type cannot express the absent field
  if (request.files === undefined || request.files.length === 0) {
    throw new Error('tests explore requires at least one file')
  }
  const pairs = facet.findImpactedTests(request.files)
    .map(row => ({ testFilePath: row.testFilePath, codeFilePath: row.codeFilePath, reason: row.reason, confidence: row.confidence }))
    .sort((left, right) => (left.testFilePath !== right.testFilePath
      ? compareStrings(left.testFilePath, right.testFilePath)
      : compareStrings(left.codeFilePath, right.codeFilePath)))
  const cap = request.max ?? limits.maxTests
  const tests = pairs.slice(0, cap)
  const truncatedReason = pairs.length > tests.length ? TRUNCATED_RESULT_LIMIT : undefined
  return finishAnswer(input, 'tests', TESTS_DECLARED, [], [], tests, [], truncatedReason, pairs.length)
}

/**
 * Assemble one explore answer from the question and the resolved tier context.
 * Dispatch is exhaustive over the closed request union; the per-op guards for
 * missing inputs throw ordinary errors (the tool consumer validates them
 * first — this is the seam's own contract enforcement).
 * @param input - the question, facet, tier limits, tier, and epochs.
 * @returns the complete graph explore answer.
 */
export function exploreGraphAnswer(input: ExploreGraphInput): GraphExploreResult {
  const { request } = input
  switch (request.op) {
    case 'relations': return relationsAnswer(input, request)
    case 'impact': return impactAnswer(input, request)
    case 'tests': return testsAnswer(input, request)
    case 'cycles': return cyclesAnswer(input, request)
    case 'dead_code': return deadCodeAnswer(input, request)
  }
}
