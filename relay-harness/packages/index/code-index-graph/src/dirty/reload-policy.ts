/**
 * Central dirty-reload policy: what happens to each stored edge category when
 * a content-unchanged file is reloaded for re-resolution.
 *
 * Ported from the reference implementation's `dirty_reload_policy.rs`, trimmed
 * to the categories this resolver carries. Every category must declare its
 * policy through the exhaustive {@linkcode policyFor} switch — the `never`
 * check there is the compile-time constraint that forces a new category's
 * author to decide, mirroring the reference's complete-destructuring rule.
 * `symbols` / `imports` carry no cross-file resolution state and stay
 * `keep`; the two resolver-owned categories clear their resolved targets so
 * the never-overwrite gate re-resolves them.
 *
 * @module @relay-harness/rlh-code-index-graph/dirty/reload-policy
 */

import type { DatabaseSync } from 'node:sqlite'
import type {
  CatalogSymbolRow,
  StoredCallEdgeRow,
  StoredSymbolRefRow,
} from '@relay-harness/rlh-code-index-search'
import { createGraphReadFacet } from '@relay-harness/rlh-code-index-sqlite'
import type { SymbolRow } from '../types.ts'
import type { ResolutionKind } from '../types.ts'
import type { DispatchKind } from '../types.ts'
import type { DirtyReresolveFile, StoredCallEdgeRow as ResolverCallEdgeRow, StoredSymbolRefRow as ResolverSymbolRefRow } from '../store/resolved-writer.ts'

/** One edge category carried through a dirty reload. */
export type ReloadedEdgeCategory = 'symbols' | 'imports' | 'callEdges' | 'symbolRefs'

/** Every category, closed so {@linkcode policyFor}'s switch stays exhaustive. */
export const RELOADED_EDGE_CATEGORIES = ['symbols', 'imports', 'callEdges', 'symbolRefs'] as const

/** What happens to a category's stored resolution state on dirty reload. */
export type ReloadPolicy = 'keep' | 'clear'

/** The per-category policy table. */
export type ReloadPolicyTable = Readonly<Record<ReloadedEdgeCategory, ReloadPolicy>>

/**
 * The policy for exactly one category. The switch must stay exhaustive over
 * {@link ReloadedEdgeCategory}: adding a category fails to compile here until
 * its policy is declared.
 */
function policyFor(category: ReloadedEdgeCategory): ReloadPolicy {
  switch (category) {
    case 'symbols':
    case 'imports':
      return 'keep'
    case 'callEdges':
    case 'symbolRefs':
      return 'clear'
    /* v8 ignore next 4: the union is closed and the cases above are
       exhaustive; the arm only turns a future new category into a compile
       error here (`never` assignment) instead of a silent `undefined`
       policy. */
    default: {
      const unhandled: never = category
      throw new Error(`unhandled reloaded edge category: ${String(unhandled)}`)
    }
  }
}

/**
 * The complete dirty-reload policy table, built through
 * {@linkcode policyFor} so the table and the per-category switch can never
 * drift apart.
 * @returns one policy per reloaded edge category.
 */
export function classifyReloadPolicy(): ReloadPolicyTable {
  const table = {} as Record<ReloadedEdgeCategory, ReloadPolicy>
  for (const category of RELOADED_EDGE_CATEGORIES) {
    table[category] = policyFor(category)
  }
  return table
}

/**
 * Project one stored `call_edges` row onto the resolver's row view. The
 * parsed-fact columns carry through verbatim; nullable resolution scalars
 * normalize to the resolver's unset markers, and the stored kind/strategy
 * tags re-enter the resolver vocabulary they were written from.
 * @param row - the row as read from the store.
 * @returns the resolver-view row; the clear policy overwrites its resolution
 *   state before resolution, so the projected values never reach the ladder.
 */
function reloadCallEdge(row: StoredCallEdgeRow): ResolverCallEdgeRow {
  return {
    edgeId: row.edgeId,
    filePath: row.filePath,
    callerSymbol: row.callerSymbol,
    // A stored row with no callee text or line carries nothing the ladder
    // could match; both normalize to the resolver's unset markers and the
    // edge stays unresolved after the clear policy runs.
    calleeSymbol: row.calleeSymbol ?? '',
    line: row.line ?? 0,
    startCol: row.startCol,
    targetSymbolId: row.targetSymbolId,
    targetFilePath: row.targetFilePath,
    callerSymbolId: row.callerSymbolId,
    callerSymbolUid: row.callerSymbolUid,
    calleeSymbolUid: row.calleeSymbolUid,
    dispatchKind: row.dispatchKind as DispatchKind | null,
    callKind: row.callKind,
    resolutionKind: row.resolutionKind as ResolutionKind,
    resolutionConfidence: row.resolutionConfidence ?? 0,
    resolutionStrategy: row.resolutionStrategy ?? '',
    receiverExpr: row.receiverExpr,
    argCount: row.argCount,
    isOptionalChain: row.isOptionalChain,
    isAwaited: row.isAwaited,
    isConstructor: row.isConstructor,
    parserTier: row.parserTier,
    parserConfidence: row.parserConfidence ?? 0,
  }
}

/** Project one stored `symbol_refs` row onto the resolver's row view; see {@linkcode reloadCallEdge}. */
function reloadSymbolRef(row: StoredSymbolRefRow): ResolverSymbolRefRow {
  return {
    refId: row.refId,
    filePath: row.filePath,
    symbolName: row.symbolName ?? '',
    container: row.container,
    refKind: row.refKind,
    line: row.line,
    col: row.col,
    targetSymbolId: row.targetSymbolId,
    targetFilePath: row.targetFilePath,
    targetSymbolUid: row.targetSymbolUid,
    refName: row.refName,
    resolutionKind: row.resolutionKind as ResolutionKind,
    resolutionConfidence: row.resolutionConfidence ?? 0,
    resolutionStrategy: row.resolutionStrategy ?? '',
    parserTier: row.parserTier,
    parserConfidence: row.parserConfidence ?? 0,
  }
}

/**
 * Project one store symbol row onto the catalog's registration row; absence
 * of the optional resolution columns normalizes explicitly to `null`, never
 * by a hidden default at the lookup site.
 * @param row - the row as read from the store's graph facet.
 * @returns the catalog row.
 */
export function catalogRowFromStored(row: CatalogSymbolRow): SymbolRow {
  return {
    symbolId: row.symbolId,
    symbolUid: row.symbolUid,
    name: row.name,
    kind: row.kind as SymbolRow['kind'],
    filePath: row.filePath,
    container: row.container,
    qname: row.qname,
    isDefaultExport: row.isDefaultExport === true,
    startLine: row.startLine,
    endLine: row.endLine,
    exportName: row.exportName ?? null,
    receiverType: row.receiverType ?? null,
    paramCount: row.paramCount ?? null,
    baseTypes: row.baseTypes ?? null,
    implements: row.implements ?? null,
    // The store schema carries no scope column; scopes stay a resolver-side
    // interface for the reference-parity step.
    scopeId: null,
  }
}

/**
 * Reload the stored edge rows of the given files for dirty re-resolution.
 *
 * Reads each file's `call_edges`, `symbol_refs`, and `imports` rows back
 * through the store's graph facet and groups them per file, producing exactly
 * the input {@link reresolveDirtyFiles} consumes. Every file appears once, in
 * input order, even when it holds no edge rows.
 * @param db - admitted store handle.
 * @param files - workspace-relative paths to reload, unique.
 * @returns one reload per file, ready for re-resolution and write-back.
 */
export function reloadEdgesForFiles(db: DatabaseSync, files: readonly string[]): DirtyReresolveFile[] {
  const facet = createGraphReadFacet(db)
  const callEdges = groupByFilePath(facet.callEdgesByFilePaths(files), reloadCallEdge)
  const symbolRefs = groupByFilePath(facet.symbolRefsByFilePaths(files), reloadSymbolRef)
  const imports = groupByFilePath(facet.importsByFilePaths(files), row => row)
  return files.map(filePath => ({
    filePath,
    callEdges: callEdges.get(filePath) ?? [],
    symbolRefs: symbolRefs.get(filePath) ?? [],
    imports: imports.get(filePath) ?? [],
  }))
}

/** Group one file-keyed row list per path, projecting through `map`. */
function groupByFilePath<Row, Projected>(
  rows: readonly Row[],
  map: (row: Row) => Projected & { filePath: string },
): Map<string, Projected[]> {
  const byFile = new Map<string, Projected[]>()
  for (const row of rows) {
    const projected = map(row)
    const bucket = byFile.get(projected.filePath)
    if (bucket === undefined) byFile.set(projected.filePath, [projected])
    else bucket.push(projected)
  }
  return byFile
}
