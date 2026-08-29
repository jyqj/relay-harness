/**
 * Parser-outcome to store-row mapping for the graph write orchestration.
 *
 * Bridges the parser package's `ParseOutcome` records onto the SQLite writer's
 * per-file graph rows (`FilesDelta.graph.byFile`), keeping every column
 * position aligned. The store's row inputs require every nullable field, while
 * parser records simply omit the columns resolution and classification own —
 * those are filled with explicit `null` / pristine defaults here, never by a
 * hidden `??` at the write site.
 *
 * @module @relay-harness/rlh-code-index-graph/store/writer
 */

import type { CallEdgeRecord, ImportRecord, LiteralRecord, ParseOutcome, SymbolRecord } from '@relay-harness/rlh-code-index-parser'
import type { SymbolRow } from '../types.ts'
import type { StoredCallEdgeRow } from './resolved-writer.ts'
import type {
  FileGraphDelta,
  ImportRowInput,
  LiteralRowInput,
  SymbolRowInput,
} from '@relay-harness/rlh-code-index-sqlite'

/**
 * Store symbol row as mapped from a parser record: the uid is always present
 * (`SymbolRecord.symbolUid` is required; the store type's `null` arm is for
 * resolution-owned rows this mapping never produces).
 */
type ParserSymbolRow = Omit<SymbolRowInput, 'symbolUid'> & { readonly symbolUid: string }

/** One parsed file's mapped rows before the dedupe pass. */
type GraphRowsFromParse = Omit<FileGraphDelta, 'symbols'> & { readonly symbols: readonly ParserSymbolRow[] }

/**
 * Map one parsed symbol onto its store row. Parser records carry no doc
 * comment, no parent span id (every parser symbol is a span root), and no
 * base-type / implements surface yet — those columns store `null`.
 */
function symbolRowInput(record: SymbolRecord): ParserSymbolRow {
  return {
    symbolId: record.symbolId,
    filePath: record.filePath,
    name: record.name,
    kind: record.kind,
    container: record.container,
    startLine: record.startLine,
    endLine: record.endLine,
    startCol: record.startCol,
    endCol: record.endCol,
    signature: record.signature,
    doc: null,
    parserTier: record.parserTier,
    parserConfidence: record.parserConfidence,
    qname: record.qname,
    parentSymbolId: record.parentSymbolId,
    exportName: record.exportName,
    isDefaultExport: record.isDefaultExport,
    symbolUid: record.symbolUid,
    frameworkRole: record.frameworkRole,
    receiverType: record.receiverType,
    paramTypes: record.paramTypes,
    returnType: record.returnType,
    paramCount: record.paramCount,
    baseTypes: null,
    implements: null,
  }
}

/** Map one parsed import onto its store row; every column parses today. */
function importRowInput(record: ImportRecord): ImportRowInput {
  return {
    filePath: record.filePath,
    importString: record.importString,
    resolvedPath: record.resolvedPath,
    importedName: record.importedName,
    alias: record.alias,
    isNamespace: record.isNamespace,
    isDefault: record.isDefault,
    isReexport: record.isReexport,
  }
}

/**
 * Map one parsed call edge onto the resolver's stored-row view with pristine
 * resolution defaults (`unresolved` / `0` / `''`): a fresh parse carries no
 * target, and the resolver's never-overwrite gate treats exactly these values
 * as unresolved and eligible. The view is row-for-row a store input too, so
 * the delta write and the resolve stage share one projection.
 * @param record - the parsed call edge.
 * @returns the resolver-view row with pristine resolution state.
 */
export function callEdgeRowFromParse(record: CallEdgeRecord): StoredCallEdgeRow {
  return {
    edgeId: record.edgeId,
    filePath: record.filePath,
    callerSymbol: record.callerSymbol,
    calleeSymbol: record.calleeSymbol,
    line: record.line,
    startCol: record.startCol,
    targetSymbolId: null,
    targetFilePath: null,
    callerSymbolId: null,
    callerSymbolUid: record.callerSymbolUid,
    calleeSymbolUid: null,
    dispatchKind: record.dispatchKind,
    callKind: record.callKind,
    resolutionKind: 'unresolved',
    resolutionConfidence: 0,
    resolutionStrategy: '',
    receiverExpr: record.receiverExpr,
    argCount: record.argCount,
    isOptionalChain: record.isOptionalChain,
    isAwaited: record.isAwaited,
    isConstructor: record.isConstructor,
    parserTier: record.parserTier,
    parserConfidence: record.parserConfidence,
  }
}

/**
 * Map one parsed literal onto its store row. Literal classification (kind,
 * confidence) arrives with a later phase, so both columns store `null`.
 */
function literalRowInput(record: LiteralRecord): LiteralRowInput {
  return {
    literalId: record.literalId,
    filePath: record.filePath,
    literal: record.literal,
    literalKind: null,
    line: record.line,
    container: record.container,
    confidence: null,
    enclosingSymbolUid: record.enclosingSymbolUid,
  }
}

/**
 * Map one parsed symbol onto the resolver catalog's registration row. The
 * columns the parser does not produce (base types, implements, scopes) store
 * explicit `null`s, matching the store rows projected from the same records.
 * @param record - the parsed symbol.
 * @returns the catalog registration row.
 */
export function catalogRowFromParse(record: SymbolRecord): SymbolRow {
  return {
    symbolId: record.symbolId,
    symbolUid: record.symbolUid,
    name: record.name,
    kind: record.kind,
    filePath: record.filePath,
    container: record.container,
    qname: record.qname,
    isDefaultExport: record.isDefaultExport,
    startLine: record.startLine,
    endLine: record.endLine,
    exportName: record.exportName,
    receiverType: record.receiverType,
    paramCount: record.paramCount,
    baseTypes: null,
    implements: null,
    scopeId: null,
  }
}

/**
 * First-come-first-kept filter over rows sharing a store key.
 * @param rows - rows in the order the parser produced them.
 * @param keyOf - the row's store key (a PRIMARY KEY or UNIQUE column value).
 * @returns the rows with later same-key repeats removed.
 */
function keepFirstBy<T>(rows: readonly T[], keyOf: (row: T) => string): T[] {
  const seen = new Set<string>()
  return rows.filter((row) => {
    const key = keyOf(row)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Drop rows whose store key repeats within one file's delta, keeping the
 * first occurrence — input order is the priority, so the pass is
 * deterministic. Real corpora produce same-key repeats: the content-derived
 * `symbolUid` collides across same-name locals of different functions and
 * across same-key overloads, and shared positions can repeat call-edge and
 * literal ids. Every key is a PRIMARY KEY or UNIQUE column, so a repeat would
 * abort the delta write (the reference store ignores repeats with `INSERT OR
 * IGNORE`).
 * @param rows - the file's mapped graph rows.
 * @returns the deduplicated rows and how many input rows were dropped.
 */
function dedupeGraphRows(rows: GraphRowsFromParse): { readonly rows: FileGraphDelta; readonly duplicatesDropped: number } {
  const deduped = {
    ...rows,
    // Symbols dedupe on both keys: same-position repeats share `symbolId`,
    // same-key overloads share `symbolUid` while sitting at distinct spans.
    symbols: keepFirstBy(keepFirstBy(rows.symbols, row => row.symbolId), row => row.symbolUid),
    callEdges: keepFirstBy(rows.callEdges, row => row.edgeId),
    literals: keepFirstBy(rows.literals, row => row.literalId),
  }
  const before = rows.symbols.length + rows.callEdges.length + rows.literals.length
  const after = deduped.symbols.length + deduped.callEdges.length + deduped.literals.length
  return { rows: deduped, duplicatesDropped: before - after }
}

/** Map one parsed file onto its store rows, before dedupe. */
function graphRowsFromOutcome(
  outcome: ParseOutcome,
  resolvedCallEdges?: readonly StoredCallEdgeRow[],
): GraphRowsFromParse {
  return {
    symbols: outcome.symbols.map(symbolRowInput),
    imports: outcome.imports.map(importRowInput),
    callEdges: resolvedCallEdges ?? outcome.callEdges.map(callEdgeRowFromParse),
    symbolRefs: [],
    testEdges: [],
    literals: outcome.literals.map(literalRowInput),
  }
}

/**
 * Map one parsed file onto its store graph rows, dropping same-key repeats
 * (first record wins).
 * @param outcome - the file's parse outcome.
 * @param resolvedCallEdges - the file's call edges after the resolve stage,
 *   replacing the pristine rows; callers that resolve before writing pass the
 *   resolver's output here so the committed rows carry their bound targets.
 * @returns the file's graph rows. `symbolRefs` and `testEdges` are empty:
 *   the parser emits no identifier refs this phase, and test edges are
 *   path-pair rows owned by the test-edge rebuild, never by per-file parse
 *   output.
 */
export function graphRowsForOutcome(
  outcome: ParseOutcome,
  resolvedCallEdges?: readonly StoredCallEdgeRow[],
): FileGraphDelta {
  return dedupeGraphRows(graphRowsFromOutcome(outcome, resolvedCallEdges)).rows
}

/** One batch's mapped graph rows plus the dedupe pass's batch-wide drop count. */
interface GraphDeltaBuild {
  readonly byFile: ReadonlyMap<string, FileGraphDelta>
  readonly duplicatesDropped: number
}

/**
 * Map a whole parsed batch onto the delta's graph half.
 * @param outcomes - one outcome per upserted file, keyed by its
 *   workspace-relative path (the parser outcome does not name its own file).
 * @returns the `FilesDelta.graph` value for a matching `FilesDelta`, in the
 *   map form of `GraphDeltaInput`, plus how many same-key rows the dedupe
 *   pass dropped batch-wide; export fingerprints stay unset — the caller
 *   computes them.
 */
export function buildGraphDelta(outcomes: ReadonlyMap<string, ParseOutcome>): GraphDeltaBuild {
  const byFile = new Map<string, FileGraphDelta>()
  let duplicatesDropped = 0
  for (const [filePath, outcome] of outcomes) {
    const deduped = dedupeGraphRows(graphRowsFromOutcome(outcome))
    duplicatesDropped += deduped.duplicatesDropped
    byFile.set(filePath, deduped.rows)
  }
  return { byFile, duplicatesDropped }
}
