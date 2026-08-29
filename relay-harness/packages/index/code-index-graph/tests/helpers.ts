/**
 * Shared row builders for the resolver suites: defaults mirror what the
 * SQLite rows project, so `resolutionKind: 'unresolved'`,
 * `resolutionConfidence: 0`, and an empty strategy mean "not yet resolved".
 */

import type {
  CallEdgeRow,
  CatalogScope,
  ImportRow,
  ParserTier,
  ScopeBinding,
  SymbolRefRow,
  SymbolRow,
  TypeAssignRow,
} from '../src/types.ts'

const TIER: ParserTier = 'tree-sitter'

/** Build one symbol row with resolution-irrelevant fields defaulted. */
export function symbolRow(overrides: Partial<SymbolRow> & Pick<SymbolRow, 'name' | 'filePath'>): SymbolRow {
  const qname = overrides.qname !== undefined ? overrides.qname : overrides.name
  return {
    symbolId: `sym:${overrides.filePath}:${overrides.name}`,
    symbolUid: `uid:${overrides.filePath}:${overrides.name}`,
    kind: 'function',
    container: null,
    isDefaultExport: false,
    startLine: 1,
    endLine: 10,
    exportName: overrides.exportName === undefined ? overrides.name : overrides.exportName,
    receiverType: null,
    paramCount: null,
    baseTypes: null,
    implements: null,
    scopeId: null,
    ...overrides,
    qname,
  }
}

/** Build one unresolved call edge. */
export function callEdge(overrides: Partial<CallEdgeRow> & Pick<CallEdgeRow, 'filePath' | 'calleeSymbol'>): CallEdgeRow {
  return {
    edgeId: `call:${overrides.filePath}:${overrides.calleeSymbol}`,
    callerSymbol: null,
    line: 5,
    targetSymbolId: null,
    targetFilePath: null,
    callerSymbolId: null,
    callerSymbolUid: null,
    calleeSymbolUid: null,
    dispatchKind: null,
    callKind: null,
    resolutionKind: 'unresolved',
    resolutionConfidence: 0,
    resolutionStrategy: '',
    receiverExpr: null,
    argCount: null,
    parserTier: TIER,
    parserConfidence: 0.8,
    ...overrides,
  }
}

/** Build one unresolved symbol ref. */
export function symbolRef(overrides: Partial<SymbolRefRow> & Pick<SymbolRefRow, 'filePath' | 'symbolName'>): SymbolRefRow {
  return {
    refId: `ref:${overrides.filePath}:${overrides.symbolName}`,
    refName: null,
    container: null,
    line: 5,
    targetSymbolId: null,
    targetFilePath: null,
    targetSymbolUid: null,
    resolutionKind: 'unresolved',
    resolutionConfidence: 0,
    resolutionStrategy: '',
    parserTier: TIER,
    parserConfidence: 0.8,
    ...overrides,
  }
}

/** Build one import row. */
export function importRow(overrides: Partial<ImportRow> & Pick<ImportRow, 'filePath' | 'importString'>): ImportRow {
  return {
    resolvedPath: null,
    importedName: null,
    alias: null,
    isNamespace: false,
    isDefault: false,
    isReexport: false,
    ...overrides,
  }
}

/** Build one lexical scope with bindings. */
export function scope(
  scopeId: string,
  filePath: string,
  startLine: number,
  endLine: number,
  bindings: readonly ScopeBinding[] = [],
  parentId: string | null = null,
  name: string = scopeId,
): CatalogScope {
  return { scopeId, filePath, startLine, endLine, bindings, parentId, name }
}

/** Build one type-assign row. */
export function typeAssign(filePath: string, varName: string, typeName: string): TypeAssignRow {
  return { filePath, varName, typeName }
}

/** Kind alias keeping builder call sites terse. */
