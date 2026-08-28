/**
 * Deterministic in-memory {@link RetrievalPort} for engine/lanes/preselect
 * specs. Implements the store-side responsibilities documented on `port.ts`
 * (recency ordering, scope enforcement, visitor protocol) over plain arrays,
 * so specs can predict every fused number without SQLite.
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
  LiteralCandidateRow,
  LiteralRow,
  RetrievalPort,
  StoredCallEdgeRow,
  StoredSymbolRefRow,
  SymbolDegreeRow,
  SymbolRowLite,
  SymbolSeedHit,
  SymbolTokenHit,
  VectorCoverage,
  VectorReadFacet,
  VectorRow,
} from '../src/port.ts'
import { quantizeInt8 } from '../src/vector-math.ts'
import { sanitizeFtsQuery, tokenizeCodeish } from '../src/text.ts'

export interface FixtureChunk {
  readonly chunkId: string
  readonly filePath: string
  readonly startLine: number
  readonly endLine: number
  readonly breadcrumb?: string
  readonly symbolName?: string
  readonly symbolKind?: string
  readonly text: string
}

interface FixtureFile {
  readonly summary: string
}

/** One stored call edge without its direction-dependent seed binding. */
type FixtureCallEdge = Omit<CallerEdgeRow, 'seedUid'>

/**
 * Mutable graph fixture slot: graph facets read exclusively from here, so
 * graph-behavior specs inject rows through this structure without touching
 * chunk/file fixtures. Defaults to empty (every graph method answers empty).
 */
export interface GraphFixtureData {
  readonly symbols: SymbolRowLite[]
  readonly callEdges: FixtureCallEdge[]
  readonly imports: ImportRow[]
  readonly chunkSpans: ChunkSpanRow[]
  readonly degrees: SymbolDegreeRow[]
  readonly impactedTests: ImpactedTestRow[]
  readonly exportFingerprints: ExportFingerprintRow[]
  readonly literals: LiteralRow[]
  /** Full reload-view edge rows; the trimmed `callEdges` stay the explore projection. */
  readonly storedCallEdges: StoredCallEdgeRow[]
  readonly storedSymbolRefs: StoredSymbolRefRow[]
}

/** Build the empty graph fixture state. */
export function emptyGraphData(): GraphFixtureData {
  return {
    symbols: [],
    callEdges: [],
    imports: [],
    chunkSpans: [],
    degrees: [],
    impactedTests: [],
    exportFingerprints: [],
    literals: [],
    storedCallEdges: [],
    storedSymbolRefs: [],
  }
}

/** Graph fixture ordering: case-insensitive exact matches first, then shortest names. */
function seedHitScore(name: string, token: string): number {
  return name.toLowerCase() === token.toLowerCase() ? 1 : 1 / (1 + Math.max(0, name.length - token.length))
}

/** Deterministic fixture ordering for {@link GraphReadFacet.symbolSeedHits}. */
function compareSeedHits(a: SymbolRowLite, b: SymbolRowLite, token: string): number {
  const exactDelta = Number(seedHitScore(b.name, token) === 1) - Number(seedHitScore(a.name, token) === 1)
  if (exactDelta !== 0) return exactDelta
  if (a.name.length !== b.name.length) return a.name.length - b.name.length
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/**
 * Fixture-backed {@link GraphReadFacet}: reads the owning index's mutable
 * `graphData` slot with minimal literal semantics, answering empty whenever
 * the slot is empty.
 */
class FixtureGraphFacet implements GraphReadFacet {
  constructor(private readonly data: () => GraphFixtureData) {}

  symbolSeedHits(token: string, limit: number): SymbolSeedHit[] {
    const needle = token.toLowerCase()
    return this.data().symbols
      .filter(symbol => symbol.symbolUid !== null && symbol.name.toLowerCase().includes(needle))
      .sort((a, b) => compareSeedHits(a, b, token))
      .slice(0, limit)
      .map(symbol => ({ symbolUid: symbol.symbolUid as string, name: symbol.name, score: seedHitScore(symbol.name, token) }))
  }

  symbolUidsByExactNames(names: readonly string[], limit: number): SymbolRowLite[] {
    const wanted = new Set(names)
    return this.data().symbols.filter(symbol => wanted.has(symbol.name)).slice(0, limit)
  }

  private edgeRowsBySide(
    uids: readonly string[],
    limit: number,
    side: 'callerSymbolUid' | 'calleeSymbolUid',
  ): CallerEdgeRow[] {
    const wanted = new Set(uids)
    const keptPerSeed = new Map<string, number>()
    const rows: CallerEdgeRow[] = []
    for (const edge of this.data().callEdges) {
      const seedUid = edge[side]
      if (seedUid === null || !wanted.has(seedUid)) continue
      const kept = keptPerSeed.get(seedUid) ?? 0
      if (kept >= limit) continue
      keptPerSeed.set(seedUid, kept + 1)
      rows.push({ ...edge, seedUid })
    }
    return rows
  }

  callerRowsByUids(uids: readonly string[], limit: number): CallerEdgeRow[] {
    return this.edgeRowsBySide(uids, limit, 'callerSymbolUid')
  }

  calleeRowsByUids(uids: readonly string[], limit: number): CallerEdgeRow[] {
    return this.edgeRowsBySide(uids, limit, 'calleeSymbolUid')
  }

  symbolRowsByUids(uids: readonly string[]): SymbolRowLite[] {
    const wanted = new Set(uids)
    return this.data().symbols.filter(symbol => symbol.symbolUid !== null && wanted.has(symbol.symbolUid))
  }

  symbolDegreeDetailsBatch(uids: readonly string[]): SymbolDegreeRow[] {
    const wanted = new Set(uids)
    const byUid = new Map(this.data().degrees.filter(row => wanted.has(row.symbolUid)).map(row => [row.symbolUid, row]))
    return [...wanted].map(symbolUid => byUid.get(symbolUid) ?? { symbolUid, inDegree: 0, outDegree: 0, refCount: 0 })
  }

  chunkSpansForFiles(files: readonly string[]): ChunkSpanRow[] {
    const wanted = new Set(files)
    return this.data().chunkSpans.filter(span => wanted.has(span.filePath))
  }

  symbolsByFilePaths(files: readonly string[]): CatalogSymbolRow[] {
    const wanted = new Set(files)
    return this.data().symbols.filter(symbol => wanted.has(symbol.filePath))
  }

  importsByFilePaths(files: readonly string[]): ImportRow[] {
    const wanted = new Set(files)
    return this.data().imports.filter(row => wanted.has(row.filePath))
  }

  callEdgesByFilePaths(files: readonly string[]): StoredCallEdgeRow[] {
    const wanted = new Set(files)
    return this.data().storedCallEdges.filter(row => wanted.has(row.filePath))
  }

  symbolRefsByFilePaths(files: readonly string[]): StoredSymbolRefRow[] {
    const wanted = new Set(files)
    return this.data().storedSymbolRefs.filter(row => wanted.has(row.filePath))
  }

  importerFilesForTargets(resolvedTargets: readonly string[]): string[] {
    const wanted = new Set(resolvedTargets)
    return [...new Set(
      this.data().imports.filter(row => row.resolvedPath !== null && wanted.has(row.resolvedPath)).map(row => row.filePath),
    )].sort()
  }

  reexportTargetsForFiles(files: readonly string[]): Map<string, readonly string[]> {
    const wanted = new Set(files)
    const byFile = new Map<string, string[]>()
    for (const row of this.data().imports) {
      if (!wanted.has(row.filePath) || !row.isReexport || row.resolvedPath === null) continue
      const targets = byFile.get(row.filePath)
      if (targets === undefined) byFile.set(row.filePath, [row.resolvedPath])
      else targets.push(row.resolvedPath)
    }
    return byFile
  }

  findImpactedTests(files: readonly string[]): ImpactedTestRow[] {
    const wanted = new Set(files)
    return this.data().impactedTests.filter(row => wanted.has(row.codeFilePath))
  }

  exportFingerprints(files: readonly string[]): ExportFingerprintRow[] {
    const wanted = new Set(files)
    return this.data().exportFingerprints.filter(row => wanted.has(row.filePath))
  }

  literalRowsByFilePaths(files: readonly string[]): LiteralRow[] {
    const wanted = new Set(files)
    return this.data().literals.filter(row => wanted.has(row.filePath))
  }

  fileImportAdjacency(): Map<string, string[]> {
    const adjacency = new Map<string, string[]>()
    for (const row of this.data().imports) {
      if (row.resolvedPath === null) continue
      const targets = adjacency.get(row.filePath)
      if (targets === undefined) adjacency.set(row.filePath, [row.resolvedPath])
      else if (!targets.includes(row.resolvedPath)) targets.push(row.resolvedPath)
    }
    for (const targets of adjacency.values()) targets.sort()
    return adjacency
  }

  analysisSymbolRows(scanLimit: number): AnalysisSymbolRow[] {
    return this.data().symbols.slice(0, Math.max(0, scanLimit)).map(row => ({
      symbolUid: row.symbolUid ?? '',
      name: row.name,
      filePath: row.filePath,
      kind: row.kind,
      hasCaller: this.data().callEdges.some(edge =>
        edge.calleeSymbolUid === (row.symbolUid ?? '')
        && (edge.callerSymbolUid === null || edge.callerSymbolUid !== (row.symbolUid ?? ''))),
      hasExternalRef: this.data().storedSymbolRefs.some(ref =>
        (ref.targetSymbolUid ?? '') === (row.symbolUid ?? '')
        && (ref.container === null || ref.container !== row.name)),
    }))
  }

  internalEdgesForUids(ids: readonly string[]): InternalImportEdgeRow[] {
    const wanted = new Set(ids)
    return this.data().imports
      .filter(row => row.resolvedPath !== null && wanted.has(row.filePath) && wanted.has(row.resolvedPath))
      .map(row => ({ from: row.filePath, to: row.resolvedPath as string, importString: row.importString }))
  }
}

/** Rowid order equals array order; LATER entries are MORE RECENT (higher rowid). */
export class InMemoryIndex implements RetrievalPort {
  private readonly chunks: FixtureChunk[] = []
  private readonly files = new Map<string, FixtureFile>()
  private readonly symbols: Array<{ filePath: string; name: string }> = []

  /** Mutable graph fixture slot backing {@link InMemoryIndex.graph}; later graph specs inject rows here. */
  graphData: GraphFixtureData = emptyGraphData()

  /** Empty-by-default graph facet over {@link InMemoryIndex.graphData}; the engine never reads it in this phase. */
  readonly graph: GraphReadFacet = new FixtureGraphFacet(() => this.graphData)

  /**
   * Optional vector facet over the mutable `vectorData` slot; `undefined`
   * until a vector spec installs {@link InMemoryIndex.installVectors}.
   */
  vector?: VectorReadFacet

  /** Quantized vectors by chunk id, served through the {@link InMemoryIndex.vector} facet. */
  vectorData = new Map<string, { bytes: Uint8Array; scale: number; norm: number; dim: number }>()

  /** Model name {@link InMemoryIndex.vectorsByChunkIds} filters on. */
  vectorModel = 'fake-embed'

  /**
   * Install the vector facet serving {@link InMemoryIndex.vectorData}: rows
   * keyed per model (other models answer empty), unknown ids omitted.
   * @param coverage - fixed coverage counters the facet reports.
   * @returns the index for chaining.
   */
  installVectors(coverage: VectorCoverage = { vectorizedChunks: 0, totalChunks: 0 }): this {
    const read = (chunkIds: readonly string[], model: string): VectorRow[] =>
      model === this.vectorModel
        ? [...this.vectorData.entries()]
          .filter(([chunkId]) => chunkIds.includes(chunkId))
          .map(([chunkId, row]) => ({ chunkId, rowid: 0, q: row.bytes, scale: row.scale, norm: row.norm, dim: row.dim }))
        : []
    this.vector = {
      vectorsByChunkIds: read,
      vectorCoverage: () => coverage,
    }
    return this
  }

  /** Quantize and store one float vector for the chunk id. */
  addVector(chunkId: string, vector: Float32Array): this {
    const quantized = quantizeInt8(vector)
    this.vectorData.set(chunkId, {
      bytes: new Uint8Array(quantized.q.buffer),
      scale: quantized.scale,
      norm: quantized.norm,
      dim: vector.length,
    })
    return this
  }

  addFile(filePath: string, summary: string): this {
    this.files.set(filePath, { summary })
    return this
  }

  addSymbol(filePath: string, name: string): this {
    this.symbols.push({ filePath, name })
    return this
  }

  addChunk(chunk: FixtureChunk): this {
    if (!this.files.has(chunk.filePath)) {
      throw new Error(`fixture references un-added file ${chunk.filePath}`)
    }
    this.chunks.push(chunk)
    return this
  }

  languageOf(filePath: string): string {
    return filePath.endsWith('.rs') ? 'rust' : filePath.endsWith('.py') ? 'python' : 'typescript'
  }

  /** Rows in recency-descending order, already scope-filtered (pre-decode). */
  private recencyRows(scope: ChunkScope, skip?: ReadonlySet<string>): GrepChunkRow[] {
    const numbered = this.chunks.map((chunk, index) => ({
      rowid: index + 1,
      chunkId: chunk.chunkId,
      filePath: chunk.filePath,
      languageName: this.languageOf(chunk.filePath),
      text: chunk.text,
    }))
    numbered.reverse()
    return numbered.filter(row =>
      row.filePath.startsWith(scope.pathPrefix ?? '')
      && (scope.filePaths === null || scope.filePaths.includes(row.filePath))
      && skip?.has(row.chunkId) !== true,
    )
  }

  private runVisit(rows: GrepChunkRow[], visit: ChunkScanVisitor, hardCap: number): void {
    let visited = 0
    for (const row of rows) {
      if (visited >= hardCap) return
      visited++
      if (!visit(row)) return
    }
  }

  scanChunksForGrep(scope: ChunkScope, skipChunkIds: ReadonlySet<string> | null, visit: ChunkScanVisitor): void {
    // The engine's visitor owns its own budget; the store imposes none.
    this.runVisit(this.recencyRows(scope, skipChunkIds ?? undefined), visit, Number.POSITIVE_INFINITY)
  }

  scanChunksForGrepPrefiltered(phrase: string, scanCap: number, scope: ChunkScope, visit: ChunkScanVisitor): void {
    const rowsMatching = this.recencyRows(scope).filter(row => this.phraseMatches(row.text, phrase))
    this.runVisit(rowsMatching, visit, scanCap)
  }

  /** Quoted-phrase adjacency check approximating unicode61 tokenization. */
  private phraseMatches(text: string, phrase: string): boolean {
    const body = phrase.replace(/^"/, '').replace(/"\*?$/, '')
    const endsStar = phrase.endsWith('*')
    const terms = body.split(/\s+/).map(term => term.toLowerCase())
    const tokens = tokenizeCodeish(text)
    if (tokens.length === 0) return false
    if (terms.length === 1) {
      const onlyTerm = body.toLowerCase()
      return endStartsWith(tokens, onlyTerm, endsStar)
    }
    for (let start = 0; start + terms.length <= tokens.length; start++) {
      let matchedAll = true
      for (const [offset, term] of terms.entries()) {
        const tokenAtWindow = tokens[start + offset]
        if (tokenAtWindow === undefined) {
          matchedAll = false
          break
        }
        const needsPrefix = offset === terms.length - 1 && endsStar
        if (needsPrefix ? !tokenAtWindow.startsWith(term) : tokenAtWindow !== term) {
          matchedAll = false
          break
        }
      }
      if (matchedAll) return true
    }
    return false
  }

  ftsChunkCandidates(matchExpr: string, scope: ChunkScope, limit: number): LexicalCandidateRow[] {
    const terms = matchExpr.split(' OR ').map(term => term.toLowerCase())
    const scored: Array<{ row: LexicalCandidateRow; matched: number }> = []
    for (const chunk of this.chunks) {
      if (!chunk.filePath.startsWith(scope.pathPrefix ?? '')) continue
      if (scope.filePaths !== null && !scope.filePaths.includes(chunk.filePath)) continue
      const tokens = new Set(tokenizeCodeish(chunk.text))
      let matched = 0
      for (const term of terms) {
        if (tokens.has(term)) matched++
      }
      if (matched > 0) {
        scored.push({
          row: {
            chunkId: chunk.chunkId,
            filePath: chunk.filePath,
            languageName: this.languageOf(chunk.filePath),
          },
          matched,
        })
      }
    }
    scored.sort((a, b) =>
      b.matched !== a.matched ? b.matched - a.matched : a.row.chunkId < b.row.chunkId ? -1 : 1,
    )
    return scored.slice(0, limit).map(entry => entry.row)
  }

  /** Literal mirror over the injected graph literals, mirroring the SQLite reader's contract. */
  literalFtsCandidates(matchExpr: string, scope: ChunkScope, limit: number): LiteralCandidateRow[] {
    const terms = matchExpr.split(' OR ').map(term => term.toLowerCase())
    const scored: Array<{ row: LiteralCandidateRow; matched: number }> = []
    for (const literal of this.graphData.literals) {
      if (!literal.filePath.startsWith(scope.pathPrefix ?? '')) continue
      if (scope.filePaths !== null && !scope.filePaths.includes(literal.filePath)) continue
      if (scope.languages !== null && !scope.languages.includes(this.languageOf(literal.filePath))) continue
      const tokens = new Set(tokenizeCodeish(literal.literal ?? ''))
      let matched = 0
      for (const term of terms) {
        if (tokens.has(term)) matched++
      }
      if (matched > 0) {
        scored.push({
          row: {
            literalId: literal.literalId,
            filePath: literal.filePath,
            literal: literal.literal,
            literalKind: literal.literalKind,
            line: literal.line,
            container: literal.container,
            rank: -matched,
          },
          matched,
        })
      }
    }
    scored.sort((a, b) =>
      b.matched !== a.matched ? b.matched - a.matched : a.row.literalId < b.row.literalId ? -1 : 1,
    )
    return scored.slice(0, limit).map(entry => entry.row)
  }

  ftsFileSummaries(matchExpr: string, pathPrefix: string | null, limit: number): FileSummaryHit[] {
    const terms = sanitizeFtsQuery(matchExpr).split(' OR ').map(term => term.toLowerCase())
    const scored: Array<{ filePath: string; matched: number }> = []
    for (const [filePath, file] of this.files) {
      if (pathPrefix !== null && !filePath.startsWith(pathPrefix)) continue
      const tokens = new Set(tokenizeCodeish(file.summary))
      let matched = 0
      for (const term of terms) {
        if (tokens.has(term)) matched++
      }
      if (matched > 0) scored.push({ filePath, matched })
    }
    scored.sort((a, b) =>
      b.matched !== a.matched ? b.matched - a.matched : a.filePath < b.filePath ? -1 : 1,
    )
    return scored.slice(0, limit).map(entry => ({ filePath: entry.filePath, rawScore: -entry.matched }))
  }

  filePathCandidatesBySubstring(token: string, pathPrefix: string | null, limit: number): string[] {
    const needle = token.toLowerCase()
    const hits: string[] = []
    for (const filePath of this.files.keys()) {
      if (pathPrefix !== null && !filePath.startsWith(pathPrefix)) continue
      if (filePath.toLowerCase().includes(needle)) hits.push(filePath)
      if (hits.length >= limit) break
    }
    return hits
  }

  symbolNamesByTokenSubstring(token: string, pathPrefix: string | null, limit: number): SymbolTokenHit[] {
    const needle = token.toLowerCase()
    const hits: SymbolTokenHit[] = []
    for (const symbol of this.symbols) {
      if (pathPrefix !== null && !symbol.filePath.startsWith(pathPrefix)) continue
      if (symbol.name.toLowerCase().includes(needle)) {
        hits.push({ filePath: symbol.filePath, name: symbol.name })
      }
      if (hits.length >= limit) break
    }
    return hits
  }

  recentIndexedFiles(limit: number): string[] {
    const paths = [...this.files.keys()].reverse()
    return paths.slice(0, limit)
  }

  chunkRowsByIds(chunkIds: readonly string[]): ChunkDetailRow[] {
    const wanted = new Set(chunkIds)
    const rows: ChunkDetailRow[] = []
    for (const chunk of this.chunks) {
      if (!wanted.has(chunk.chunkId)) continue
      rows.push({
        chunkId: chunk.chunkId,
        filePath: chunk.filePath,
        languageName: this.languageOf(chunk.filePath),
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        breadcrumb: chunk.breadcrumb ?? '',
        symbolName: chunk.symbolName ?? null,
        symbolKind: chunk.symbolKind ?? null,
        text: chunk.text,
      })
    }
    return rows
  }

  countFiles(): number {
    return this.files.size
  }
}

function endStartsWith(tokens: readonly string[], term: string, prefixMode: boolean): boolean {
  return tokens.some(token => (prefixMode ? token.startsWith(term) : token === term))
}
