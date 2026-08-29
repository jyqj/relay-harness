/**
 * Graph enrichment for context search — resolves search hits to symbol uids,
 * derives a connectivity-based graph score per chunk, and collects neighbor
 * (caller/callee) and test-coverage context nodes.
 *
 * Ported verbatim from the reference implementation
 * (`crates/cc-search/src/enrich.rs::graph_enrich`). Every store read is
 * best-effort: a rejection degrades to an empty result and is recorded in the
 * explain envelope (`readErrors`) instead of failing the search, so hits keep
 * flowing either way. Budget breaks clip the remaining candidate nodes of the
 * affected section (callers, callees, tests) rather than skipping oversized
 * entries one by one.
 *
 * Node views are this package's intermediate form; the consumer-facing
 * projection is a later phase's job.
 *
 * @module @relay-harness/rlh-code-index-graph/lane/enrich
 */

import type { GraphEnrichLimits, SearchHit } from '@relay-harness/rlh-code-index'
import type {
  CatalogSymbolRow,
  CallerEdgeRow,
  ImpactedTestRow,
  RetrievalPort,
  SymbolDegreeRow,
} from '@relay-harness/rlh-code-index-search'
import { edgesBySeed } from './edges.ts'
import type { ResolutionKind } from '../types.ts'
import { defaultResolutionConfidence } from '../resolver/penalties.ts'
import { GraphExplainCollector, SEARCH_ENRICH_EDGE_KINDS } from './explain.ts'
import type { GraphExplain } from './explain.ts'

/**
 * Upper cap of the graph score formula, ported verbatim from the reference's
 * `min(connectivity + ref_bonus, 0.4)` — a use-site literal there, kept as a
 * named constant here so the enrich/engine halves share one spelling.
 */
export const GRAPH_SCORE_CAP = 0.4

/** One enrichment context node — the package's intermediate view of a neighbor or test entry. */
export interface GraphEnrichNodeView {
  /** Stable node identity: `graph:caller:{uid}` / `graph:callee:{uid}` / `graph:test:{path}`. */
  readonly nodeId: string
  /** Node class; mirrors the reference's `NodeType` members this path emits. */
  readonly nodeType: 'call_edge' | 'test_edge'
  /** Why the node is present: a 1-hop call neighbor or an impacted test. */
  readonly role: 'neighbor' | 'test'
  /** Short model-facing title. */
  readonly title: string
  /** One-line detail with the edge or file reference. */
  readonly text: string
  /** File the edge call site or test lives in. */
  readonly filePath?: string
  /** 1-based line of the call site, when the edge carries one. */
  readonly startLine?: number
  /** Resolution confidence of the backing call edge (kind-derived; `0` when unresolved). */
  readonly confidence?: number
  /** Enrichment token estimate: `max(floor(text bytes / 4), 10)`. */
  readonly tokenEstimate: number
  /** Provenance marker of the enrichment stage. */
  readonly source: 'graph'
}

/** Non-score outputs of graph enrichment: context nodes plus counters and the explain envelope. */
export interface GraphEnrichOutput {
  /** Per-chunk graph score (raw connectivity, before the rerank weight), keyed by chunk id. */
  readonly assignments: ReadonlyMap<string, number>
  /** Collected neighbor and test context nodes in collection order. */
  readonly nodes: readonly GraphEnrichNodeView[]
  /** Distinct hit symbols resolved to uids. */
  readonly symbolsResolved: number
  /** Caller nodes added. */
  readonly callersAdded: number
  /** Callee nodes added. */
  readonly calleesAdded: number
  /** Test nodes added. */
  readonly testsFound: number
  /** Degradation envelope; `isEmpty` when the run completed cleanly. */
  readonly explain: GraphExplain
}

/** Inputs of one enrichment run over the final base hits. */
export interface GraphEnrichInput {
  /** Base search hits, already finalized by the engine. */
  readonly hits: readonly SearchHit[]
  /** Retrieval port whose graph facet answers the batched reads. */
  readonly port: RetrievalPort
  /** Tier enrichment caps (resolve/caller/callee/test caps and the budget percentage). */
  readonly limits: Readonly<GraphEnrichLimits>
  /** Operation token budget; the graph section claims `limits.graphBudgetPct` of it. */
  readonly tokenBudget: number
}

/** Shared encoder for the byte-accurate token estimate (`text.len()` is bytes in the reference). */
const textEncoder = new TextEncoder()

/** Resolution kinds the resolver's default-confidence table maps; anything else counts as unresolved. */
const RESOLUTION_KINDS: readonly string[] = ['unresolved', 'exact', 'qualified', 'scope_resolved', 'heuristic']

/**
 * Estimate one node's token cost: `max(floor(text bytes / 4), 10)`.
 * @param text - node detail text.
 * @returns the enrichment token estimate.
 */
function tokenEstimateOf(text: string): number {
  return Math.max(Math.floor(textEncoder.encode(text).length / 4), 10)
}

/**
 * Derive the node confidence from the edge's resolution kind — the reference
 * copies the stored edge confidence, which the retrieval port's edge projection
 * does not carry, so the kind's default confidence stands in (`0` when the
 * kind is absent or unknown).
 * @param kind - resolution kind as stored on the edge row.
 * @returns the kind's default confidence in `[0, 1]`.
 */
function edgeConfidence(kind: string | null): number {
  return kind !== null && RESOLUTION_KINDS.includes(kind)
    ? defaultResolutionConfidence(kind as ResolutionKind)
    : 0
}

/**
 * Read one edge direction grouped by seed, degrading a rejection to no groups
 * and recording it in the envelope.
 * @param explain - collector the failure is recorded into.
 * @param op - store operation name for the envelope entry.
 * @param read - the facet edge lookup.
 * @returns the rows grouped under their seed uid.
 */
function readEdgesBySeed(
  explain: GraphExplainCollector,
  op: string,
  read: () => readonly CallerEdgeRow[],
): Map<string, readonly CallerEdgeRow[]> {
  try {
    return edgesBySeed(read())
  } catch (error) {
    explain.recordReadError(op, error)
    return new Map()
  }
}

/**
 * Distinct test file paths in first-seen order. The reference's SQL answers
 * `DISTINCT test_file_path`; the port projection returns raw association rows,
 * so the dedup happens here.
 * @param rows - impacted-test association rows in store order.
 * @returns distinct test file paths.
 */
function distinctTestPaths(rows: readonly ImpactedTestRow[]): string[] {
  const paths: string[] = []
  for (const row of rows) {
    if (!paths.includes(row.testFilePath)) {
      paths.push(row.testFilePath)
    }
  }
  return paths
}

/**
 * Compute per-chunk graph scores and collect graph context nodes.
 * @param input - the base hits, the port, the tier enrichment caps, and the token budget.
 * @returns the `(chunkId -> graphScore)` assignments plus nodes, counters, and the explain envelope.
 */
export function graphEnrich(input: GraphEnrichInput): GraphEnrichOutput {
  const { hits, port, limits, tokenBudget } = input
  const nodes: GraphEnrichNodeView[] = []
  const assignments = new Map<string, number>()
  if (hits.length === 0) {
    const explain = new GraphExplainCollector().finish()
    return { assignments, nodes, symbolsResolved: 0, callersAdded: 0, calleesAdded: 0, testsFound: 0, explain }
  }
  const explain = new GraphExplainCollector()
  explain.declareEdgeKinds(SEARCH_ENRICH_EDGE_KINDS)
  let callersAdded = 0
  let calleesAdded = 0
  let testsFound = 0

  // 1. Batch-load symbols for the resolve window's distinct file paths.
  const resolveWindow = hits.slice(0, limits.maxResolve)
  const filePaths = [...new Set(resolveWindow.map(hit => hit.filePath))]
  let allSymbols: readonly CatalogSymbolRow[] = []
  try {
    allSymbols = port.graph.symbolsByFilePaths(filePaths)
  } catch (error) {
    explain.recordReadError('symbols_by_file_paths', error)
  }

  // 2. Resolve each hit → symbol uid via name equality or span containment,
  //    deduplicating uids globally so two hits on one symbol resolve once.
  const resolved: Array<readonly [string, string]> = []
  const seenUids = new Set<string>()
  for (const hit of resolveWindow) {
    const symbol = allSymbols.find(candidate =>
      candidate.filePath === hit.filePath
      && (hit.symbolName === candidate.name
        || (candidate.startLine <= hit.startLine && candidate.endLine >= hit.endLine)))
    const uid = symbol?.symbolUid
    if (uid !== null && uid !== undefined && !seenUids.has(uid)) {
      seenUids.add(uid)
      resolved.push([hit.chunkId, uid])
    }
  }
  const symbolsResolved = resolved.length

  const resolvedUids = resolved.map(([, uid]) => uid)
  const degreeByUid = new Map<string, SymbolDegreeRow>()
  try {
    for (const row of port.graph.symbolDegreeDetailsBatch(resolvedUids)) {
      degreeByUid.set(row.symbolUid, row)
    }
  } catch (error) {
    explain.recordReadError('symbol_degree_details_batch', error)
  }

  // 3. Degree metrics → graph score per chunk: ln(in+out+1)/10 + min(refs,10)/100, capped.
  for (const [chunkId, uid] of resolved) {
    const info = degreeByUid.get(uid)
    if (info === undefined) continue
    const connectivity = Math.log(info.inDegree + info.outDegree + 1) / 10
    const refBonus = Math.min(info.refCount, 10) / 100
    assignments.set(chunkId, Math.min(connectivity + refBonus, GRAPH_SCORE_CAP))
  }

  // 4. Callers + callees → context nodes under the graph's token budget.
  // The port names directions by the seed side (rows where the uids ARE the
  // callers/callees), the reference names them by the neighbor side (rows
  // where the uids HAVE callers/callees): callers of a symbol therefore read
  // through `calleeRowsByUids` (rows where it is the callee) and vice versa.
  // The explain op names keep the reference vocabulary.
  const graphBudget = Math.floor((tokenBudget * limits.graphBudgetPct) / 100)
  let graphTokens = 0
  const neighborUids = new Set<string>()
  const callersByUid = readEdgesBySeed(explain, 'caller_rows_by_uids', () => port.graph.calleeRowsByUids(resolvedUids, limits.callersPerSym))
  const calleesByUid = readEdgesBySeed(explain, 'callee_rows_by_uids', () => port.graph.callerRowsByUids(resolvedUids, limits.calleesPerSym))

  for (const [, uid] of resolved) {
    for (const edge of callersByUid.get(uid) ?? []) {
      const callerUid = edge.callerSymbolUid ?? ''
      if (callerUid === '' || neighborUids.has(callerUid)) continue
      neighborUids.add(callerUid)
      const text = `caller: ${edge.callerSymbol ?? '?'} → ${edge.calleeSymbol ?? '?'} (${edge.filePath}:${edge.line ?? 0})`
      const estimate = tokenEstimateOf(text)
      if (graphTokens + estimate > graphBudget) {
        explain.markTruncated('output_budget')
        break
      }
      graphTokens += estimate
      nodes.push({
        nodeId: `graph:caller:${callerUid}`,
        nodeType: 'call_edge',
        role: 'neighbor',
        title: `Caller: ${edge.callerSymbol ?? '?'}`,
        text,
        filePath: edge.filePath,
        ...(edge.line === null ? {} : { startLine: edge.line }),
        confidence: edgeConfidence(edge.resolutionKind),
        tokenEstimate: estimate,
        source: 'graph',
      })
      callersAdded++
    }
    for (const edge of calleesByUid.get(uid) ?? []) {
      const calleeUid = edge.calleeSymbolUid ?? ''
      if (calleeUid === '' || neighborUids.has(calleeUid)) continue
      neighborUids.add(calleeUid)
      const text = `callee: ${edge.callerSymbol ?? '?'} → ${edge.calleeSymbol ?? '?'} (${edge.filePath}:${edge.line ?? 0})`
      const estimate = tokenEstimateOf(text)
      if (graphTokens + estimate > graphBudget) {
        explain.markTruncated('output_budget')
        break
      }
      graphTokens += estimate
      nodes.push({
        nodeId: `graph:callee:${calleeUid}`,
        nodeType: 'call_edge',
        role: 'neighbor',
        title: `Callee: ${edge.calleeSymbol ?? '?'}`,
        text,
        filePath: edge.filePath,
        ...(edge.line === null ? {} : { startLine: edge.line }),
        confidence: edgeConfidence(edge.resolutionKind),
        tokenEstimate: estimate,
        source: 'graph',
      })
      calleesAdded++
    }
  }

  // 5. Test coverage: a failed lookup degrades to "no test nodes" but is
  //    recorded instead of silently swallowed.
  let impactedTests: readonly ImpactedTestRow[] = []
  try {
    impactedTests = port.graph.findImpactedTests(filePaths)
  } catch (error) {
    explain.recordReadError('find_impacted_tests', error)
  }
  for (const testPath of distinctTestPaths(impactedTests).slice(0, limits.maxTests)) {
    const text = `test file: ${testPath}`
    const estimate = tokenEstimateOf(text)
    if (graphTokens + estimate > graphBudget) {
      explain.markTruncated('output_budget')
      break
    }
    graphTokens += estimate
    nodes.push({
      nodeId: `graph:test:${testPath}`,
      nodeType: 'test_edge',
      role: 'test',
      title: `Test: ${testPath}`,
      text,
      filePath: testPath,
      tokenEstimate: estimate,
      source: 'graph',
    })
    testsFound++
  }

  return { assignments, nodes, symbolsResolved, callersAdded, calleesAdded, testsFound, explain: explain.finish() }
}
