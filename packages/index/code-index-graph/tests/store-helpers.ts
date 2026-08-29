/**
 * Store-suite fixtures: minimal stand-ins for the SQLite writer's input rows,
 * kept local because the storage package exports its contract types, not its
 * test builders.
 */

import { openCodeIndexDatabase, writeFilesDelta } from '@relay-harness/rlh-code-index-sqlite'
import type { FileUpsert } from '@relay-harness/rlh-code-index-sqlite'
import type { StoredCallEdgeRow, StoredSymbolRefRow } from '../src/store/resolved-writer.ts'

/** Build one minimal file upsert for store seeding. */
export function fileUpsertFixture(path: string, isTest = false): FileUpsert {
  return {
    filePath: path,
    language: 'typescript',
    contentHash: `hash-${path}`,
    mtime: 1.5,
    size: 64,
    summary: `summary for ${path}`,
    contentExcerpt: '',
    parserTier: 'generic',
    parserConfidence: 0.5,
    isTestFile: isTest,
    chunks: [{
      chunkId: `chunk:${path}:0`,
      chunkIndex: 0,
      startLine: 1,
      endLine: 10,
      breadcrumb: '',
      symbolName: null,
      symbolKind: null,
      text: `body of ${path}`,
      tokenEstimate: 8,
    }],
  }
}

/**
 * Open an in-memory store and seed it with the given paths, committing one
 * delta. The caller owns the returned handle.
 */
export async function seededStore(paths: readonly (string | [path: string, isTest: boolean])[] = []): Promise<import('node:sqlite').DatabaseSync> {
  const db = await openCodeIndexDatabase(':memory:')
  writeFilesDelta(db, {
    removals: [],
    upserts: paths.map(entry => typeof entry === 'string'
      ? fileUpsertFixture(entry)
      : fileUpsertFixture(entry[0], entry[1])),
  })
  return db
}

/** Build one stored call edge carrying stale resolved-target state. */
export function storedCallEdge(overrides: Partial<StoredCallEdgeRow> & Pick<StoredCallEdgeRow, 'filePath' | 'edgeId' | 'calleeSymbol'>): StoredCallEdgeRow {
  return {
    callerSymbol: 'run',
    line: 12,
    startCol: 4,
    targetSymbolId: 'sym:dead',
    targetFilePath: 'src/dead.ts',
    callerSymbolId: 'sym:app:run',
    callerSymbolUid: 'uid:app:run',
    calleeSymbolUid: 'uid:dead',
    dispatchKind: 'direct',
    callKind: 'member',
    resolutionKind: 'exact',
    resolutionConfidence: 1,
    resolutionStrategy: 'exact',
    receiverExpr: null,
    argCount: 1,
    isOptionalChain: false,
    isAwaited: false,
    isConstructor: false,
    parserTier: 'tree-sitter',
    parserConfidence: 0.8,
    ...overrides,
  }
}

/** Build one stored symbol ref carrying stale resolved-target state. */
export function storedSymbolRef(overrides: Partial<StoredSymbolRefRow> & Pick<StoredSymbolRefRow, 'filePath' | 'refId' | 'symbolName'>): StoredSymbolRefRow {
  return {
    refName: null,
    container: null,
    line: 12,
    col: 8,
    refKind: 'identifier',
    targetSymbolId: 'sym:dead',
    targetFilePath: 'src/dead.ts',
    targetSymbolUid: 'uid:dead',
    resolutionKind: 'exact',
    resolutionConfidence: 1,
    resolutionStrategy: 'exact',
    parserTier: 'tree-sitter',
    parserConfidence: 0.8,
    ...overrides,
  }
}

/** Count rows of one table. */
export function tableCount(db: import('node:sqlite').DatabaseSync, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
}
