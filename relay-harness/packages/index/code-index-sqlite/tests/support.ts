/** Shared fixtures for the storage write/read suites. */

import type {
  CallEdgeRowInput,
  ChunkUpsert,
  FileGraphDelta,
  FileUpsert,
  ImportRowInput,
  LiteralRowInput,
  SymbolRefRowInput,
  SymbolRowInput,
  TestEdgeRowInput,
} from '../src/writer.ts'

/** Build one chunk positioned at its index with plain text payload. */
export function chunkUpsert(filePath: string, chunkIndex: number, text: string): ChunkUpsert {
  return {
    chunkId: `chunk:${filePath}:${chunkIndex}`,
    chunkIndex,
    startLine: chunkIndex * 10 + 1,
    endLine: chunkIndex * 10 + 10,
    breadcrumb: '',
    symbolName: null,
    symbolKind: null,
    text,
    tokenEstimate: Math.ceil(text.length / 4),
  }
}

/** Build one generic-tier TypeScript file upsert carrying the given chunk texts. */
export function fileUpsert(filePath: string, texts: readonly string[]): FileUpsert {
  return {
    filePath,
    language: 'typescript',
    contentHash: `hash-${filePath}`,
    mtime: 1.5,
    size: 100 + texts.join('').length,
    summary: `summary for ${filePath}`,
    contentExcerpt: texts[0] ?? '',
    parserTier: 'generic',
    parserConfidence: 0.5,
    isTestFile: false,
    chunks: texts.map((text, chunkIndex) => chunkUpsert(filePath, chunkIndex, text)),
  }
}

/** Render ascending ISO timestamps so `indexed_at` recency ordering is deterministic. */
export function clock(startMs = 1_700_000_000_000): () => string {
  let current = startMs
  return () => {
    const stamp = new Date(current).toISOString()
    current += 1000
    return stamp
  }
}

/** Build one symbol row with the given uid and every graph column populated. */
export function symbolRow(filePath: string, name: string, symbolUid: string | null): SymbolRowInput {
  return {
    symbolId: `sym:${filePath}:${name}`,
    filePath,
    name,
    kind: 'function',
    container: 'outerScope',
    startLine: 10,
    endLine: 20,
    startCol: 2,
    endCol: 30,
    signature: `function ${name}()`,
    doc: `doc for ${name}`,
    parserTier: 'semantic',
    parserConfidence: 0.9,
    qname: `mod.${name}`,
    parentSymbolId: 'sym:parent',
    exportName: name,
    isDefaultExport: false,
    symbolUid,
    frameworkRole: 'handler',
    receiverType: null,
    paramTypes: 'string',
    returnType: 'void',
    paramCount: 1,
    baseTypes: null,
    implements: null,
  }
}

/** Build one import row exercising namespace/default/re-export flags. */
export function importRow(filePath: string, importString: string): ImportRowInput {
  return {
    filePath,
    importString,
    resolvedPath: 'src/resolved.ts',
    importedName: 'helper',
    alias: 'h',
    isNamespace: false,
    isDefault: true,
    isReexport: false,
  }
}

/** Build one call edge bound to the given caller/callee uids. */
export function callEdgeRow(
  filePath: string,
  edgeId: string,
  callerSymbolUid: string | null,
  calleeSymbolUid: string | null,
  line: number | null,
): CallEdgeRowInput {
  return {
    edgeId,
    filePath,
    callerSymbol: 'callerFn',
    calleeSymbol: 'calleeFn',
    line,
    startCol: 4,
    targetSymbolId: null,
    targetFilePath: null,
    callerSymbolId: 'sym:caller',
    callerSymbolUid,
    calleeSymbolUid,
    dispatchKind: 'direct',
    callKind: 'direct',
    resolutionKind: 'resolved',
    resolutionConfidence: 0.8,
    resolutionStrategy: 'local-exact',
    receiverExpr: 'router',
    argCount: 2,
    isOptionalChain: false,
    isAwaited: true,
    isConstructor: false,
    parserTier: 'tree-sitter',
    parserConfidence: 0.7,
  }
}

/** Build one symbol reference row. */
export function symbolRefRow(filePath: string, refId: string, targetSymbolUid: string | null): SymbolRefRowInput {
  return {
    refId,
    filePath,
    symbolName: 'targetFn',
    container: null,
    refKind: 'identifier',
    line: 15,
    col: 8,
    targetSymbolId: null,
    targetFilePath: null,
    targetSymbolUid,
    refName: 'targetFn',
    resolutionKind: 'resolved',
    resolutionConfidence: 0.6,
    resolutionStrategy: 'import',
    parserTier: 'semantic',
    parserConfidence: 0.9,
  }
}

/** Build one test edge with the given reason/confidence (null maps through the reader to ''/0). */
export function testEdgeRow(
  edgeId: string,
  testFilePath: string,
  codeFilePath: string,
  reason: string | null,
  confidence: number | null,
): TestEdgeRowInput {
  return { edgeId, testFilePath, codeFilePath, reason, confidence }
}

/** Build one literal row. */
export function literalRow(filePath: string, literalId: string, literal: string): LiteralRowInput {
  return {
    literalId,
    filePath,
    literal,
    literalKind: 'string',
    line: 7,
    container: 'buildUrl',
    confidence: 0.5,
    enclosingSymbolUid: 'uid:buildUrl',
  }
}

/** Assemble one file's graph half from optional row lists. */
export function fileGraphDelta(parts: Partial<FileGraphDelta> & { readonly exportFingerprint?: string }): FileGraphDelta {
  return {
    symbols: [],
    imports: [],
    callEdges: [],
    symbolRefs: [],
    testEdges: [],
    literals: [],
    ...parts,
  }
}

/** Row counts across every store a delta touches, for residue assertions. */
export function storageCounts(db: import('node:sqlite').DatabaseSync): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const table of [
    'files',
    'chunks',
    'chunks_fts',
    'files_fts',
    'file_paths_fts',
    'symbols',
    'symbols_fts',
    'imports',
    'symbol_refs',
    'call_edges',
    'test_edges',
    'literal_index',
  ]) {
    counts[table] = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
  }
  return counts
}
