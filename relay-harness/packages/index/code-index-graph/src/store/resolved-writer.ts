/**
 * Dirty-reresolve write orchestration: clear, re-resolve, persist.
 *
 * When a file's content is unchanged but a dependency's export surface moved,
 * the indexer reloads its stored edge rows and re-resolves them instead of
 * re-parsing. Every stored resolution state must then be declared: this knife
 * ships the reference's `dirty_reload_policy.rs` table trimmed to the two
 * resolver-owned categories — call edges and symbol refs clear their resolved
 * targets unconditionally (`ClearResolvedTargets`) — while `symbols` /
 * `imports` carry no cross-file resolution state and never pass through here.
 * The cleared rows go through the resolver, and the resolver-owned result
 * lands through the SQLite writer's `writeResolvedEdges`, replacing each
 * file's two edge row sets inside one epoch-bumped transaction.
 *
 * @module @relay-harness/rlh-code-index-graph/store/resolved-writer
 */

import type { DatabaseSync } from 'node:sqlite'
import type {
  CallEdgeRowInput,
  SymbolRefRowInput,
  WriteResolvedEdgesResult,
} from '@relay-harness/rlh-code-index-sqlite'
import { writeResolvedEdges } from '@relay-harness/rlh-code-index-sqlite'
import type { SymbolResolver } from '../index.ts'
import type { CallEdgeRow, ImportRow, SymbolRefRow } from '../types.ts'

/**
 * Stored call edge on its way through a dirty reresolve: the resolver's row
 * view plus the parsed-fact columns resolution does not touch, which the
 * reload must carry so the write-back can restore them verbatim.
 */
export interface StoredCallEdgeRow extends CallEdgeRow {
  /** 0-based UTF-8 byte start column of the call site, when known. */
  readonly startCol: number | null
  /** True for `a?.b()` sites. */
  readonly isOptionalChain: boolean
  /** True when the call sits directly under `await`. */
  readonly isAwaited: boolean
  /** True for `new C()` sites. */
  readonly isConstructor: boolean
}

/**
 * Stored symbol ref on its way through a dirty reresolve: the resolver's row
 * view plus the parsed-fact columns resolution does not touch.
 */
export interface StoredSymbolRefRow extends SymbolRefRow {
  /** 0-based UTF-8 byte column of the reference, when known. */
  readonly col: number | null
  /** Reference classification as extracted, when known. */
  readonly refKind: string | null
}

/**
 * Apply the reference's `ClearResolvedTargets` policy to one call edge:
 * every resolved-target column drops, strategy and confidence reset to their
 * pristine parse defaults. `targetSymbolId` must clear together with the uid —
 * the resolver's never-overwrite gate skips any row that still carries a
 * target id, so a kept id with a cleared uid would be written back as a
 * silently dangling edge.
 * @param edge - the stored call edge to clear.
 * @returns a copy of the edge with its resolution state cleared; extra
 *   stored fields (parsed facts) carry through unchanged.
 */
export function clearResolvedCallEdge<Row extends CallEdgeRow>(edge: Row): Row {
  return {
    ...edge,
    targetSymbolId: null,
    targetFilePath: null,
    calleeSymbolUid: null,
    resolutionKind: 'unresolved',
    resolutionConfidence: 0,
    resolutionStrategy: '',
  }
}

/**
 * Apply {@link clearResolvedCallEdge}'s policy to one symbol ref; the same
 * never-overwrite gate makes `targetSymbolId` part of the cleared set.
 * @param ref - the stored symbol ref to clear.
 * @returns a copy of the ref with its resolution state cleared.
 */
export function clearResolvedSymbolRef<Row extends SymbolRefRow>(ref: Row): Row {
  return {
    ...ref,
    targetSymbolId: null,
    targetFilePath: null,
    targetSymbolUid: null,
    resolutionKind: 'unresolved',
    resolutionConfidence: 0,
    resolutionStrategy: '',
  }
}

/** One dirty file's reloaded rows plus the imports the resolver needs. */
export interface DirtyReresolveFile {
  /** Workspace-relative path of the reloaded file. */
  readonly filePath: string
  /** The file's stored call edges, resolution state as stored. */
  readonly callEdges: readonly StoredCallEdgeRow[]
  /** The file's stored symbol refs, resolution state as stored. */
  readonly symbolRefs: readonly StoredSymbolRefRow[]
  /** The file's stored imports, feeding the ladder's import step. */
  readonly imports: readonly ImportRow[]
}

/** Counts reported by one {@link reresolveDirtyFiles} call. */
export interface DirtyReresolveResult extends WriteResolvedEdgesResult {
  /** Call edges whose target this pass bound. */
  readonly resolvedCallEdgeCount: number
  /** Symbol refs whose target this pass bound. */
  readonly resolvedSymbolRefCount: number
}

/** Project one resolver output row onto its store input row. */
function callEdgeInput(row: StoredCallEdgeRow): CallEdgeRowInput {
  return {
    edgeId: row.edgeId,
    filePath: row.filePath,
    callerSymbol: row.callerSymbol,
    calleeSymbol: row.calleeSymbol,
    line: row.line,
    startCol: row.startCol,
    targetSymbolId: row.targetSymbolId,
    targetFilePath: row.targetFilePath,
    callerSymbolId: row.callerSymbolId,
    callerSymbolUid: row.callerSymbolUid,
    calleeSymbolUid: row.calleeSymbolUid,
    dispatchKind: row.dispatchKind,
    callKind: row.callKind,
    resolutionKind: row.resolutionKind,
    resolutionConfidence: row.resolutionConfidence,
    resolutionStrategy: row.resolutionStrategy,
    receiverExpr: row.receiverExpr,
    argCount: row.argCount,
    isOptionalChain: row.isOptionalChain,
    isAwaited: row.isAwaited,
    isConstructor: row.isConstructor,
    parserTier: row.parserTier,
    parserConfidence: row.parserConfidence,
  }
}

/** Project one resolver output ref onto its store input row. */
function symbolRefInput(row: StoredSymbolRefRow): SymbolRefRowInput {
  return {
    refId: row.refId,
    filePath: row.filePath,
    symbolName: row.symbolName,
    container: row.container,
    refKind: row.refKind,
    line: row.line,
    col: row.col,
    targetSymbolId: row.targetSymbolId,
    targetFilePath: row.targetFilePath,
    targetSymbolUid: row.targetSymbolUid,
    refName: row.refName,
    resolutionKind: row.resolutionKind,
    resolutionConfidence: row.resolutionConfidence,
    resolutionStrategy: row.resolutionStrategy,
    parserTier: row.parserTier,
    parserConfidence: row.parserConfidence,
  }
}

/**
 * Reresolve the given dirty files and persist the rewritten edges: the
 * ClearResolvedTargets policy wipes every stored resolution state, the
 * resolver binds targets copy-on-write over the cleared rows, and the result
 * replaces each file's `call_edges` and `symbol_refs` row sets through one
 * {@link writeResolvedEdges} call — a single transaction, one index-epoch
 * bump. Rows the resolver left untouched keep their (cleared, unresolved)
 * state, so a target that no longer exists stays unresolved instead of
 * dangling.
 * @param db - admitted handle; must not have another transaction open.
 * @param resolver - resolver created over the current symbol catalog.
 * @param files - one entry per dirty file, unique paths.
 * @returns bind and write counts, observable only after the COMMIT succeeded.
 * @throws Any statement failure aborts the whole unit; nothing persists and
 *   the index epoch does not move.
 */
export function reresolveDirtyFiles(
  db: DatabaseSync,
  resolver: SymbolResolver,
  files: readonly DirtyReresolveFile[],
): DirtyReresolveResult {
  const resolved = resolver.resolveEdges({
    callEdges: files.flatMap(file => file.callEdges).map(clearResolvedCallEdge),
    symbolRefs: files.flatMap(file => file.symbolRefs).map(clearResolvedSymbolRef),
    imports: files.flatMap(file => file.imports),
  })
  const callEdgesByFile = new Map<string, CallEdgeRowInput[]>()
  for (const row of resolved.callEdges) {
    const rows = callEdgesByFile.get(row.filePath) ?? []
    rows.push(callEdgeInput(row))
    callEdgesByFile.set(row.filePath, rows)
  }
  const symbolRefsByFile = new Map<string, SymbolRefRowInput[]>()
  for (const row of resolved.symbolRefs) {
    const rows = symbolRefsByFile.get(row.filePath) ?? []
    rows.push(symbolRefInput(row))
    symbolRefsByFile.set(row.filePath, rows)
  }
  const written = writeResolvedEdges(db, files.map(file => ({
    filePath: file.filePath,
    callEdges: callEdgesByFile.get(file.filePath) ?? [],
    symbolRefs: symbolRefsByFile.get(file.filePath) ?? [],
  })))
  return {
    ...written,
    resolvedCallEdgeCount: resolved.resolvedCallEdgeCount,
    resolvedSymbolRefCount: resolved.resolvedSymbolRefCount,
  }
}
