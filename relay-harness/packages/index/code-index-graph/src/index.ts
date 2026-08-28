/**
 * Symbol-resolution layer for the local code-index capability: a pure
 * in-memory resolver that binds unresolved call edges and symbol refs to
 * target symbols through a nine-step ladder (self-member, scope binding,
 * same-file, import, suffix, global-unique, and three fuzzy-narrowing
 * steps), followed by a type-catalog second pass over the edges it touched.
 *
 * The resolver is ported from the reference implementation's `cc-index`
 * resolver (`resolver/{catalog,resolve_core,resolve_outcome}.rs`). It owns no
 * storage: callers feed changed files' rows plus a symbol catalog, and get
 * rewritten rows back. The store-side write orchestration lives in
 * `store/`; the retrieval side lives in `lane/`: the graph retrieval lane and
 * the graph-neighbor preselect layer, ported from the reference
 * implementation's `cc-search` graph pieces and composed into engine defaults
 * through this package's `lane/defaults` exports.
 *
 * @module @relay-harness/rlh-code-index-graph
 */

import { resolveName, strategyOfResult } from './resolver/ladder.ts'
import {
  applyTypeCatalogCandidate,
  typeCatalogCandidate,
  typeUpgradeGate,
} from './resolver/type-catalog.ts'
import {
  classifyCallKind,
  defaultResolutionConfidence,
  defaultResolutionStrategy,
  hasRichContext,
  signalsOf,
  toResolutionKind,
} from './resolver/penalties.ts'
import { SymbolCatalog } from './resolver/catalog.ts'
import type { CatalogEntry } from './resolver/catalog.ts'
import type { TypeCatalog } from './resolver/type-catalog.ts'
import type { ImportBinding } from './types.ts'
import type {
  CallEdgeRow,
  CatalogScope,
  ImportRow,
  ResolutionKind,
  SymbolRefRow,
  TypeAssignRow,
} from './types.ts'

export { SymbolCatalog } from './resolver/catalog.ts'
export type { CatalogEntry, SymbolCatalogOptions } from './resolver/catalog.ts'
export { LANE_GRAPH_ID, createGraphLane } from './lane/graph-lane.ts'
export { LAYER_GRAPH_NEIGHBOR, createGraphNeighborLayer } from './lane/neighbor-layer.ts'
export {
  defaultRetrievalLanesWithGraph,
  defaultPreselectLayersWithGraphNeighbor,
} from './lane/defaults.ts'
export {
  GRAPH_EXPLAIN_MAX_READ_ERRORS,
  SEARCH_ENRICH_EDGE_KINDS,
  GraphExplainCollector,
} from './lane/explain.ts'
export type { GraphExplain, GraphTruncatedReason } from './lane/explain.ts'
export { GRAPH_SCORE_CAP, graphEnrich } from './lane/enrich.ts'
export type { GraphEnrichInput, GraphEnrichNodeView, GraphEnrichOutput } from './lane/enrich.ts'
export {
  DEFAULT_GRAPH_RESULT_CACHE_CAPACITY,
  GRAPH_RERANK_REASON,
  createGraphResultCache,
  searchWithGraphContext,
} from './lane/engine.ts'
export type {
  GraphEnrichment,
  GraphResultCache,
  GraphSearchOutcome,
  SearchWithGraphContextInput,
} from './lane/engine.ts'
export { CatalogSliceCache, ResolveMemo, resolveMemoKey } from './resolver/catalog-cache.ts'
export { RESOLVE_LADDER, resolveName, strategyOfResult } from './resolver/ladder.ts'
export { TypeCatalog, applyTypeCatalogCandidate, typeCatalogCandidate, typeUpgradeGate } from './resolver/type-catalog.ts'
export type { SymbolKeyMeta, TypeCatalogCandidate, TypeUpgradeGate } from './resolver/type-catalog.ts'
export {
  BASE_CONFIDENCE,
  bestByImportDistance,
  buildAliasMap,
  candidateCountPenalty,
  classifyCallKind,
  commonPathPrefixLen,
  dedupById,
  defaultResolutionConfidence,
  defaultResolutionStrategy,
  dottedPrefixMatch,
  hasRichContext,
  importBindingOf,
  isImportReachable,
  pickUnique,
  scopeChain,
  scopeDistance,
  scopeForLine,
  signalsOf,
  strategyForResult,
  stripExt,
  stripExtToDotted,
  toResolutionKind,
} from './resolver/penalties.ts'
export type {
  CallEdgeRow,
  CallKind,
  CallSiteSignals,
  CatalogScope,
  DispatchKind,
  ImportBinding,
  ImportRow,
  InternalResKind,
  ResolutionKind,
  ResolveStep,
  ScopeBinding,
  StrategyName,
  SymbolKind,
  SymbolRefRow,
  SymbolRow,
  ParserTier,
  TypeAssignRow,
} from './types.ts'

export {
  buildGraphDelta,
  callEdgeRowFromParse,
  catalogRowFromParse,
  graphRowsForOutcome,
} from './store/writer.ts'
export {
  applyTestEdgeRebuild,
  decideTestEdgeRebuild,
} from './store/test-edge-policy.ts'
export type { TestEdgeRebuildDecision, TestEdgeRebuildInput } from './store/test-edge-policy.ts'
export {
  clearResolvedCallEdge,
  clearResolvedSymbolRef,
  reresolveDirtyFiles,
} from './store/resolved-writer.ts'
export type {
  DirtyReresolveFile,
  DirtyReresolveResult,
  StoredCallEdgeRow,
  StoredSymbolRefRow,
} from './store/resolved-writer.ts'
export { computeExportFingerprint, exportFingerprintsChanged, reexportTargetsChanged } from './dirty/export-fingerprint.ts'
export type { ExportSurfaceSymbol } from './dirty/export-fingerprint.ts'
export { DIRTY_CLOSURE_MAX_ROUNDS, closureStatusOf, computeDirtyClosure } from './dirty/closure.ts'
export type { DirtyClosureInput, DirtyClosureResult, DirtyPropagationStatus } from './dirty/closure.ts'
export {
  RELOADED_EDGE_CATEGORIES,
  catalogRowFromStored,
  classifyReloadPolicy,
  reloadEdgesForFiles,
} from './dirty/reload-policy.ts'
export type { ReloadedEdgeCategory, ReloadPolicy, ReloadPolicyTable } from './dirty/reload-policy.ts'
export { DEFAULT_DIRTY_MAX_FILES, runDirtyPropagation } from './dirty/run-dirty.ts'
export type {
  DirtyPropagationConfig,
  DirtyPropagationReport,
  RunDirtyPropagationInput,
} from './dirty/run-dirty.ts'

/** Construction options of the symbol resolver. */
export interface SymbolResolverOptions {
  /** Catalog the resolution runs against; the caller owns its lifetime. */
  readonly catalog: SymbolCatalog
  /**
   * Lazy-load hook invoked once per `resolveEdges` call with the distinct
   * resolved module paths the request's imports reference. The hook must be
   * synchronous and populate the catalog for those files (typically through
   * {@link CatalogSliceCache} over a store read); when omitted, the catalog
   * is used exactly as it stands.
   */
  readonly loadSymbolsForFiles?: (files: readonly string[]) => void
}

/**
 * One resolveEdges request: changed files' rows plus their imports. Generic
 * over the row views so callers holding richer rows (the stored-row view with
 * its parsed-fact columns) get them back verbatim through the copy-on-write
 * pass.
 */
export interface ResolveEdgesRequest<CallEdge extends CallEdgeRow = CallEdgeRow, Ref extends SymbolRefRow = SymbolRefRow> {
  /** Call-edge rows of the changed files; unresolved rows are rewritten. */
  readonly callEdges: readonly CallEdge[]
  /** Symbol-ref rows of the changed files; unresolved rows are rewritten. */
  readonly symbolRefs: readonly Ref[]
  /** Import rows declared in the changed files, grouped per row's filePath. */
  readonly imports: readonly ImportRow[]
  /**
   * Variable type-assignment records feeding the embedded type catalog's
   * receiver inference (the reference's `type_assigns`); optional.
   */
  readonly typeAssigns?: readonly TypeAssignRow[]
  /**
   * Lexical scopes of the changed files for the scope-binding step; optional
   * and normally empty — no parser emits scopes yet, the interface stays for
   * the reference-parity step.
   */
  readonly scopes?: readonly CatalogScope[]
}

/** Rewritten rows plus counts of targets this pass bound. */
export interface ResolveEdgesResult<CallEdge extends CallEdgeRow = CallEdgeRow, Ref extends SymbolRefRow = SymbolRefRow> {
  /**
   * Call-edge rows in input order; untouched rows keep their original object
   * identity, rewritten rows are new objects.
   */
  readonly callEdges: readonly CallEdge[]
  /**
   * Symbol-ref rows in input order; untouched rows keep their original
   * object identity, rewritten rows are new objects.
   */
  readonly symbolRefs: readonly Ref[]
  /** Call edges whose target symbol this pass bound. */
  readonly resolvedCallEdgeCount: number
  /** Symbol refs whose target symbol this pass bound. */
  readonly resolvedSymbolRefCount: number
}

/** The pure in-memory symbol resolver created by {@link createSymbolResolver}. */
export interface SymbolResolver {
  /** Catalog the resolver runs against. */
  readonly catalog: SymbolCatalog
  /**
   * Resolve one changed-files batch copy-on-write: rows already carrying a
   * target are never overwritten (only their empty strategy/confidence
   * defaults are backfilled), everything else goes through the ladder (with
   * import context) or the find-best fallback, then through the type-catalog
   * second pass under its gate, then through the caller-uid backfill — the
   * reference's `resolve_outcome_with_context` pass order.
   *
   * @param request - The changed rows, their imports, and optional
   * scope/type-assign context.
   * @returns Rewritten rows and bind counts, typed as the input row views.
   */
  resolveEdges<CallEdge extends CallEdgeRow, Ref extends SymbolRefRow>(
    request: ResolveEdgesRequest<CallEdge, Ref>,
  ): ResolveEdgesResult<CallEdge, Ref>
}

/**
 * Create a symbol resolver over a catalog.
 *
 * @param options - Catalog and optional lazy-load hook.
 * @returns The resolver.
 */
export function createSymbolResolver(options: SymbolResolverOptions): SymbolResolver {
  return new SymbolResolverImpl(options)
}

class SymbolResolverImpl implements SymbolResolver {
  constructor(private readonly options: SymbolResolverOptions) {}

  get catalog(): SymbolCatalog {
    return this.options.catalog
  }

  resolveEdges<CallEdge extends CallEdgeRow, Ref extends SymbolRefRow>(
    request: ResolveEdgesRequest<CallEdge, Ref>,
  ): ResolveEdgesResult<CallEdge, Ref> {
    const catalog = this.options.catalog
    const scopes = scopeMapOf(request.scopes)

    this.loadImportTargets(request.imports)
    if (request.typeAssigns !== undefined) catalog.addTypeAssigns(request.typeAssigns)

    const importBindings = new importBindingsMemo(request.imports)

    let resolvedCallEdgeCount = 0
    const callEdges = request.callEdges.map((edge) => {
      const resolved = resolveCallEdge(catalog, edge, edge.filePath, scopes, importBindings)
      resolvedCallEdgeCount += resolved.bound
      return resolved.edge
    })
    let resolvedSymbolRefCount = 0
    const symbolRefs = request.symbolRefs.map((ref) => {
      const resolved = resolveSymbolRef(catalog, ref, ref.filePath, scopes, importBindings)
      resolvedSymbolRefCount += resolved.bound
      return resolved.ref
    })


    // Second sweep, gated per edge: the type-catalog pass may touch edges the
    // main pass left backfillable or upgradeable.
    const afterTypePass = catalog.typeCatalog === null
      ? callEdges
      : callEdges.map(edge => applyTypePass(catalog, edge))
    // Third sweep: caller uid backfill through the find-best fallback.
    const finalEdges = afterTypePass.map(edge => backfillCaller(catalog, edge, edge.filePath))

    return {
      callEdges: finalEdges,
      symbolRefs,
      resolvedCallEdgeCount,
      resolvedSymbolRefCount,
    }
  }

  /**
   * Hand the distinct resolved module paths the request's imports reference
   * to the caller's lazy-load hook, sorted for deterministic loader behavior.
   */
  private loadImportTargets(imports: readonly ImportRow[]): void {
    const loader = this.options.loadSymbolsForFiles
    if (loader === undefined) return
    const files = new Set<string>()
    for (const row of imports) {
      if (row.resolvedPath !== null) files.add(row.resolvedPath)
    }
    if (files.size === 0) return
    loader([...files].sort())
  }
}

/** Per-file import-binding projection, computed once per distinct file. */
class importBindingsMemo {
  private readonly byRow: ImportRow[]
  private readonly cache = new Map<string, ImportBinding[]>()

  constructor(rows: readonly ImportRow[]) {
    this.byRow = [...rows]
  }

  /** Bindings declared in the file, in row order. */
  forFile(file: string): ImportBinding[] {
    const cached = this.cache.get(file)
    if (cached !== undefined) return cached
    const bindings = SymbolCatalog.buildImportBindings(this.byRow.filter(row => row.filePath === file))
    this.cache.set(file, bindings)
    return bindings
  }
}

/** Key the scope list by scope id for the chain lookups. */
function scopeMapOf(scopes: readonly CatalogScope[] | undefined): ReadonlyMap<string, CatalogScope> {
  if (scopes === undefined || scopes.length === 0) return new Map()
  const map = new Map<string, CatalogScope>()
  for (const scope of scopes) map.set(scope.scopeId, scope)
  return map
}

/**
 * Backfill a row's unset strategy and zero confidence from its stored kind
 * (the reference applies both defaults before its never-overwrite gate).
 *
 * @param row - The row to backfill.
 * @returns The row, or a copy with defaults filled.
 */
function backfillDefaults<
  Row extends { resolutionKind: ResolutionKind; resolutionConfidence: number; resolutionStrategy: string },
>(row: Row): Row {
  let current = row
  if (current.resolutionStrategy === '') {
    current = { ...current, resolutionStrategy: defaultResolutionStrategy(current.resolutionKind) }
  }
  if (current.resolutionConfidence <= 0) {
    current = { ...current, resolutionConfidence: defaultResolutionConfidence(current.resolutionKind) }
  }
  return current
}

/**
 * Resolve one call edge: default backfill, the never-overwrite gate, the
 * ladder or find-best fallback, and the call-hit side effects (direct
 * dispatch plus the five-branch call classification).
 */
function resolveCallEdge<Row extends CallEdgeRow>(
  catalog: SymbolCatalog,
  edge: Row,
  file: string,
  scopes: ReadonlyMap<string, CatalogScope>,
  importBindings: importBindingsMemo,
): { edge: Row; bound: number } {
  let current = backfillDefaults(edge)
  if (current.targetSymbolId !== null) return { edge: current, bound: 0 }

  const imports = importBindings.forFile(file)
  let resolved = false
  if (hasRichContext(scopes, imports)) {
    const result = resolveName(catalog, {
      name: current.calleeSymbol,
      file,
      line: current.line,
      scopes,
      imports,
      container: current.callerSymbol,
      signals: signalsOf(current),
    })
    if (result !== null) {
      const entry = catalog.entries[result.catalogIndex] as CatalogEntry
      current = {
        ...current,
        targetSymbolId: entry.symbolId,
        targetFilePath: entry.filePath,
        calleeSymbolUid: entry.symbolUid,
        resolutionKind: toResolutionKind(result.resolutionKind),
        resolutionConfidence: result.confidence,
        resolutionStrategy: strategyOfResult(result),
        dispatchKind: 'direct',
        callKind: classifyCallKind(current.calleeSymbol, imports),
      }
      resolved = true
    }
  }
  if (!resolved) {
    const idx = catalog.findBest(current.calleeSymbol, file)
    if (idx !== undefined) {
      current = applyFallback(catalog, current, idx, file)
      resolved = true
    }
  }
  return { edge: current, bound: resolved ? 1 : 0 }
}

/** Resolve one symbol ref: default backfill, the gate, then ladder or fallback. */
function resolveSymbolRef<Row extends SymbolRefRow>(
  catalog: SymbolCatalog,
  ref: Row,
  file: string,
  scopes: ReadonlyMap<string, CatalogScope>,
  importBindings: importBindingsMemo,
): { ref: Row; bound: number } {
  let current = backfillDefaults(ref)
  if (current.targetSymbolId !== null) return { ref: current, bound: 0 }

  const imports = importBindings.forFile(file)
  const raw = current.refName ?? current.symbolName
  let resolved = false
  if (hasRichContext(scopes, imports)) {
    const result = resolveName(catalog, {
      name: raw,
      file,
      line: current.line ?? 0,
      scopes,
      imports,
      container: current.container,
      signals: { argCount: null, receiver: null },
    })
    if (result !== null) {
      const entry = catalog.entries[result.catalogIndex] as CatalogEntry
      current = {
        ...current,
        targetSymbolId: entry.symbolId,
        targetFilePath: entry.filePath,
        targetSymbolUid: entry.symbolUid,
        resolutionKind: toResolutionKind(result.resolutionKind),
        resolutionConfidence: result.confidence,
        resolutionStrategy: strategyOfResult(result),
      }
      resolved = true
    }
  }
  if (!resolved) {
    const idx = catalog.findBest(raw, file)
    if (idx !== undefined) {
      const entry = catalog.entries[idx] as CatalogEntry
      const kind: ResolutionKind = entry.filePath === file ? 'scope_resolved' : 'heuristic'
      current = {
        ...current,
        targetSymbolId: entry.symbolId,
        targetFilePath: entry.filePath,
        targetSymbolUid: entry.symbolUid,
        resolutionKind: kind,
        resolutionConfidence: defaultResolutionConfidence(kind),
        resolutionStrategy: entry.filePath === file ? 'same_file_fallback' : 'global_fallback',
      }
      resolved = true
    }
  }
  return { ref: current, bound: resolved ? 1 : 0 }
}

/** Find-best fallback (`same_file_fallback`/`global_fallback` + default confidence). */
function applyFallback<Row extends CallEdgeRow>(
  catalog: SymbolCatalog,
  edge: Row,
  idx: number,
  file: string,
): Row {
  const entry = catalog.entries[idx] as CatalogEntry
  const sameFile = entry.filePath === file
  const kind: ResolutionKind = sameFile ? 'scope_resolved' : 'heuristic'
  return {
    ...edge,
    targetSymbolId: entry.symbolId,
    targetFilePath: entry.filePath,
    calleeSymbolUid: entry.symbolUid,
    resolutionKind: kind,
    resolutionConfidence: defaultResolutionConfidence(kind),
    resolutionStrategy: sameFile ? 'same_file_fallback' : 'global_fallback',
  }
}

/**
 * Type-catalog second pass for one edge: the gate decides between skip,
 * unconditional backfill, and a strictly-better upgrade whose strategy
 * records `"{strategy}:upgraded_from={old}"`.
 */
function applyTypePass<Row extends CallEdgeRow>(catalog: SymbolCatalog, edge: Row): Row {
  const gate = typeUpgradeGate(edge)
  if (gate === 'skip') return edge
  const candidate = typeCatalogCandidate(catalog.typeCatalog as TypeCatalog, edge, uid => catalog.findByUid(uid))
  if (candidate === undefined) return edge
  if (gate === 'backfill') return applyTypeCatalogCandidate(edge, candidate, catalog.entries)

  const differs = edge.calleeSymbolUid === null || edge.calleeSymbolUid !== candidate.uid
  if (!differs || candidate.confidence <= edge.resolutionConfidence) return edge
  const upgraded = applyTypeCatalogCandidate(edge, candidate, catalog.entries)
  return { ...upgraded, resolutionStrategy: `${candidate.strategy}:upgraded_from=${edge.resolutionStrategy}` }
}

/** Resolve a missing caller uid through the find-best fallback. */
function backfillCaller<Row extends CallEdgeRow>(catalog: SymbolCatalog, edge: Row, file: string): Row {
  if (edge.callerSymbolUid !== null || edge.callerSymbol === null) return edge
  const idx = catalog.findBest(edge.callerSymbol, file)
  if (idx === undefined) return edge
  const entry = catalog.entries[idx] as CatalogEntry
  return {
    ...edge,
    callerSymbolUid: entry.symbolUid,
    callerSymbolId: entry.symbolId,
  }
}
