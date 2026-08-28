/**
 * Deterministic in-memory {@link RetrievalPort} for the lane suites: the graph
 * facet reads injected arrays with the store's documented semantics (per-seed
 * caps, exact-name equality, recency scan order), and the chunk/file surface
 * is just rich enough to drive the real engine through the composed defaults.
 */

import type {
  AnalysisSymbolRow,
  CallerEdgeRow,
  CatalogSymbolRow,
  ChunkDetailRow,
  ChunkScope,
  ChunkSpanRow,
  ChunkScanVisitor,
  ExportFingerprintRow,
  FileSummaryHit,
  GraphReadFacet,
  GrepChunkRow,
  ImpactedTestRow,
  ImportRow,
  InternalImportEdgeRow,
  LexicalCandidateRow,
  LiteralRow,
  RetrievalPort,
  StoredCallEdgeRow,
  StoredSymbolRefRow,
  SymbolDegreeRow,
  SymbolRowLite,
  SymbolSeedHit,
  SymbolTokenHit,
} from '@relay-harness/rlh-code-index-search'
import { tokenizeCodeish } from '@relay-harness/rlh-code-index-search'

/** One injected call edge without its direction-dependent seed binding. */
export type FixtureEdge = Omit<CallerEdgeRow, 'seedUid'>

/** Compact symbol row builder: uid derives from the name, spans default tight. */
export function symbol(overrides: Partial<SymbolRowLite> & Pick<SymbolRowLite, 'name' | 'filePath'>): SymbolRowLite {
  const name = overrides.name
  return {
    symbolId: `sym:${name}`,
    symbolUid: `uid:${name}`,
    kind: 'function',
    container: null,
    startLine: 1,
    endLine: 2,
    qname: name,
    signature: null,
    ...overrides,
  }
}

/** Compact call-edge builder: the declaring file is the caller's file. */
export function edge(overrides: Partial<FixtureEdge> & Pick<FixtureEdge, 'callerSymbolUid' | 'calleeSymbolUid'>): FixtureEdge {
  return {
    filePath: 'src/caller.ts',
    line: 3,
    callerSymbol: null,
    calleeSymbol: null,
    resolutionKind: 'exact',
    dispatchKind: 'direct',
    callKind: 'local',
    ...overrides,
  }
}

/**
 * Graph facet over injected arrays: `symbolSeedHits` ranks case-insensitive
 * exact matches first then shortest names, edge lookups cap per seed, and the
 * remaining explore/reload methods answer empty.
 */
class FixtureGraphFacet implements GraphReadFacet {
  constructor(private readonly state: () => FixtureState) {}

  symbolSeedHits(token: string, limit: number): SymbolSeedHit[] {
    const needle = token.toLowerCase()
    const hits = this.state().symbols
      .filter(row => row.symbolUid !== null && row.name.toLowerCase().includes(needle))
      .sort((a, b) => {
        const exactDelta = Number(b.name.toLowerCase() === needle) - Number(a.name.toLowerCase() === needle)
        return exactDelta !== 0 ? exactDelta : a.name.length - b.name.length || (a.name < b.name ? -1 : 1)
      })
      .slice(0, limit)
      .map(row => ({ symbolUid: row.symbolUid as string, name: row.name, score: 1 }))
    return hits
  }

  symbolUidsByExactNames(names: readonly string[], limit: number): SymbolRowLite[] {
    const wanted = new Set(names)
    return this.state().symbols.filter(row => wanted.has(row.name)).slice(0, limit)
  }

  private edgesBySide(uids: readonly string[], limit: number, side: 'callerSymbolUid' | 'calleeSymbolUid'): CallerEdgeRow[] {
    const wanted = new Set(uids)
    const keptPerSeed = new Map<string, number>()
    const rows: CallerEdgeRow[] = []
    for (const row of this.state().callEdges) {
      const seedUid = row[side]
      if (seedUid === null || !wanted.has(seedUid)) continue
      const kept = keptPerSeed.get(seedUid) ?? 0
      if (kept >= limit) continue
      keptPerSeed.set(seedUid, kept + 1)
      rows.push({ ...row, seedUid })
    }
    return rows
  }

  callerRowsByUids(uids: readonly string[], limit: number): CallerEdgeRow[] {
    return this.edgesBySide(uids, limit, 'callerSymbolUid')
  }

  calleeRowsByUids(uids: readonly string[], limit: number): CallerEdgeRow[] {
    return this.edgesBySide(uids, limit, 'calleeSymbolUid')
  }

  symbolRowsByUids(uids: readonly string[]): SymbolRowLite[] {
    const wanted = new Set(uids)
    return this.state().symbols.filter(row => row.symbolUid !== null && wanted.has(row.symbolUid))
  }

  symbolsByFilePaths(files: readonly string[]): CatalogSymbolRow[] {
    const wanted = new Set(files)
    return this.state().symbols.filter(row => wanted.has(row.filePath))
  }

  chunkSpansForFiles(files: readonly string[]): ChunkSpanRow[] {
    const wanted = new Set(files)
    return this.state().chunkSpans.filter(span => wanted.has(span.filePath))
  }

  symbolDegreeDetailsBatch(uids: readonly string[]): SymbolDegreeRow[] {
    const injected = new Map(this.state().degrees.map(row => [row.symbolUid, row]))
    return [...uids].map(symbolUid => injected.get(symbolUid) ?? { symbolUid, inDegree: 0, outDegree: 0, refCount: 0 })
  }

  importsByFilePaths(): ImportRow[] {
    return []
  }

  callEdgesByFilePaths(): StoredCallEdgeRow[] {
    return []
  }

  symbolRefsByFilePaths(): StoredSymbolRefRow[] {
    return []
  }

  importerFilesForTargets(): string[] {
    return []
  }

  reexportTargetsForFiles(): Map<string, readonly string[]> {
    return new Map()
  }

  findImpactedTests(files: readonly string[]): ImpactedTestRow[] {
    const wanted = new Set(files)
    return this.state().impactedTests.filter(row => wanted.has(row.codeFilePath))
  }

  exportFingerprints(): ExportFingerprintRow[] {
    return []
  }

  literalRowsByFilePaths(): LiteralRow[] {
    return []
  }

  fileImportAdjacency(): Map<string, readonly string[]> {
    return new Map()
  }

  analysisSymbolRows(): AnalysisSymbolRow[] {
    return []
  }

  internalEdgesForUids(): InternalImportEdgeRow[] {
    return []
  }
}

/** Injection slot plus the file/chunk surface the engine pipeline reads. */
export interface FixtureState {
  files: Map<string, string>
  chunks: Array<{ chunkId: string; filePath: string; startLine: number; endLine: number; text: string }>
  symbols: SymbolRowLite[]
  callEdges: FixtureEdge[]
  chunkSpans: ChunkSpanRow[]
  degrees: SymbolDegreeRow[]
  impactedTests: ImpactedTestRow[]
}

/** Empty fixture state. */
function emptyState(): FixtureState {
  return {
    files: new Map(),
    chunks: [],
    symbols: [],
    callEdges: [],
    chunkSpans: [],
    degrees: [],
    impactedTests: [],
  }
}

/** The fixture port; `graph` reads the mutable {@link FixtureState}. */
export class FixturePort implements RetrievalPort {
  readonly state: FixtureState = emptyState()
  readonly graph: GraphReadFacet = new FixtureGraphFacet(() => this.state)

  addFile(filePath: string, summary: string): this {
    this.state.files.set(filePath, summary)
    return this
  }

  addChunk(chunk: FixtureState['chunks'][number]): this {
    this.state.chunks.push(chunk)
    return this
  }

  addSymbol(row: SymbolRowLite): this {
    this.state.symbols.push(row)
    return this
  }

  addEdge(row: FixtureEdge): this {
    this.state.callEdges.push(row)
    return this
  }

  addSpan(span: ChunkSpanRow): this {
    this.state.chunkSpans.push(span)
    return this
  }

  addDegree(row: SymbolDegreeRow): this {
    this.state.degrees.push(row)
    return this
  }

  addImpactedTest(row: ImpactedTestRow): this {
    this.state.impactedTests.push(row)
    return this
  }

  countFiles(): number {
    return this.state.files.size
  }

  filePathCandidatesBySubstring(token: string, pathPrefix: string | null, limit: number): string[] {
    const needle = token.toLowerCase()
    const hits: string[] = []
    for (const filePath of this.state.files.keys()) {
      if (pathPrefix !== null && !filePath.startsWith(pathPrefix)) continue
      if (filePath.toLowerCase().includes(needle)) hits.push(filePath)
      if (hits.length >= limit) break
    }
    return hits
  }

  symbolNamesByTokenSubstring(token: string, pathPrefix: string | null, limit: number): SymbolTokenHit[] {
    const needle = token.toLowerCase()
    const hits: SymbolTokenHit[] = []
    for (const row of this.state.symbols) {
      if (pathPrefix !== null && !row.filePath.startsWith(pathPrefix)) continue
      if (row.name.toLowerCase().includes(needle)) {
        hits.push({ filePath: row.filePath, name: row.name })
      }
      if (hits.length >= limit) break
    }
    return hits
  }

  ftsFileSummaries(matchExpr: string, pathPrefix: string | null, limit: number): FileSummaryHit[] {
    const terms = matchExpr.split(' OR ').map(term => term.toLowerCase())
    const scored: Array<{ filePath: string; matched: number }> = []
    for (const [filePath, summary] of this.state.files) {
      if (pathPrefix !== null && !filePath.startsWith(pathPrefix)) continue
      const tokens = new Set(tokenizeCodeish(summary))
      let matched = 0
      for (const term of terms) {
        if (tokens.has(term)) matched++
      }
      if (matched > 0) scored.push({ filePath, matched })
    }
    scored.sort((a, b) => b.matched - a.matched || (a.filePath < b.filePath ? -1 : 1))
    return scored.slice(0, limit).map(row => ({ filePath: row.filePath, rawScore: -row.matched }))
  }

  recentIndexedFiles(limit: number): string[] {
    return [...this.state.files.keys()].reverse().slice(0, limit)
  }

  ftsChunkCandidates(matchExpr: string, scope: ChunkScope, limit: number): LexicalCandidateRow[] {
    const terms = matchExpr.split(' OR ').map(term => term.toLowerCase())
    const scored: Array<{ row: LexicalCandidateRow; matched: number }> = []
    for (const chunk of this.recencyChunks(scope)) {
      const tokens = new Set(tokenizeCodeish(chunk.text))
      let matched = 0
      for (const term of terms) {
        if (tokens.has(term)) matched++
      }
      if (matched > 0) {
        scored.push({
          row: { chunkId: chunk.chunkId, filePath: chunk.filePath, languageName: 'typescript' },
          matched,
        })
      }
    }
    scored.sort((a, b) => b.matched - a.matched || (a.row.chunkId < b.row.chunkId ? -1 : 1))
    return scored.slice(0, limit).map(row => row.row)
  }

  scanChunksForGrepPrefiltered(phrase: string, scanCap: number, scope: ChunkScope, visit: ChunkScanVisitor): void {
    const needle = phrase.replaceAll('"', '').replace(/\*$/, '').toLowerCase()
    const rows = this.recencyChunks(scope).filter(row => tokenizeCodeish(row.text).some(token => token === needle))
    let visited = 0
    for (const row of rows) {
      if (visited >= scanCap) return
      visited++
      if (!visit(row)) return
    }
  }

  scanChunksForGrep(scope: ChunkScope, skipChunkIds: ReadonlySet<string> | null, visit: ChunkScanVisitor): void {
    for (const row of this.recencyChunks(scope)) {
      if (skipChunkIds?.has(row.chunkId) === true) continue
      if (!visit(row)) return
    }
  }

  chunkRowsByIds(chunkIds: readonly string[]): ChunkDetailRow[] {
    const wanted = new Set(chunkIds)
    const rows: ChunkDetailRow[] = []
    for (const chunk of this.state.chunks) {
      if (!wanted.has(chunk.chunkId)) continue
      rows.push({
        chunkId: chunk.chunkId,
        filePath: chunk.filePath,
        languageName: 'typescript',
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        breadcrumb: '',
        symbolName: null,
        symbolKind: null,
        text: chunk.text,
      })
    }
    return rows
  }

  private recencyChunks(scope: ChunkScope): GrepChunkRow[] {
    return this.state.chunks
      .map((chunk, index) => ({
        rowid: index + 1,
        chunkId: chunk.chunkId,
        filePath: chunk.filePath,
        languageName: 'typescript',
        text: chunk.text,
      }))
      .reverse()
      .filter(row =>
        row.filePath.startsWith(scope.pathPrefix ?? '')
        && (scope.filePaths === null || scope.filePaths.includes(row.filePath)),
      )
  }
}
