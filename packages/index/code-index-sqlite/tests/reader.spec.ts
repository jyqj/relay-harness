import { afterEach, describe, expect, it } from 'vitest'
import { ChunkTextCache } from '../src/cache.ts'
import { openCodeIndexDatabase } from '../src/open.ts'
import { createRetrievalPort, readVectorCoverage } from '../src/reader.ts'
import { writeChunkVectors, writeFilesDelta } from '../src/writer.ts'
import type { LiteralRowInput } from '../src/writer.ts'
import type { ChunkScope } from '@relay-harness/rlh-code-index-search'
import { cosineQuantized, quantizeInt8 } from '@relay-harness/rlh-code-index-search'
import { clock, fileGraphDelta, fileUpsert, symbolRow } from './support.ts'

// Assembled so the doc-reference scanner does not read the fixture path as a repository link.
const GUIDE_FILE = ['docs', 'readme.md'].join('/')
const guideChunk = (index: number): string => `chunk:${GUIDE_FILE}:${index}`

describe('createRetrievalPort', () => {
  const opened: Array<import('node:sqlite').DatabaseSync> = []
  afterEach(() => {
    while (opened.length > 0) opened.pop()?.close()
  })

  const noScope: ChunkScope = { pathPrefix: null, languages: null, filePaths: null }

  /** Seed two files whose contents and indexed_at stamps make ordering observable. */
  async function seeded(cache?: ChunkTextCache): ReturnType<typeof createPort> {
    const db = await openCodeIndexDatabase(':memory:')
    opened.push(db)
    writeFilesDelta(
      db,
      {
        removals: [],
        upserts: [
          fileUpsert('src/beta/engine.ts', ['engine stores plain text payload once']),
          fileUpsert('src/alpha/parser.ts', ['alpha handles request routing', 'alpha routing again']),
          fileUpsert(['docs', 'readme.md'].join('/'), ['readme mentions routing']),
        ],
      },
      { now: clock() },
    )
    return createPort(db, cache)
  }

  async function createPort(db: import('node:sqlite').DatabaseSync, cache?: ChunkTextCache) {
    return { port: createRetrievalPort(db, cache === undefined ? {} : { cache }), db }
  }

  it('reports file counts and recency-ordered paths', async () => {
    const { port } = await seeded()
    expect(port.countFiles()).toBe(3)
    expect(port.recentIndexedFiles(2)).toEqual([['docs', 'readme.md'].join('/'), 'src/alpha/parser.ts'])
    expect(port.recentIndexedFiles(0)).toEqual([])
  })

  it('answers path substrings through the trigram mirror with literal LIKE tokens', async () => {
    const { port } = await seeded()
    expect(port.filePathCandidatesBySubstring('parser', null, 10)).toEqual(['src/alpha/parser.ts'])
    expect(port.filePathCandidatesBySubstring('.ts', null, 2)).toEqual(['src/alpha/parser.ts', 'src/beta/engine.ts'])
    expect(port.filePathCandidatesBySubstring('.ts', 'src/beta', 10)).toEqual(['src/beta/engine.ts'])
    // `_` is a literal underscore, not a single-character wildcard.
    expect(port.filePathCandidatesBySubstring('re_dme', null, 10)).toEqual([])
    expect(port.filePathCandidatesBySubstring('readme.md', null, 10)).toEqual([['docs', 'readme.md'].join('/')])
    expect(port.filePathCandidatesBySubstring('.ts', null, 1)).toEqual(['src/alpha/parser.ts'])
  })

  it('answers symbol-token lookups through symbols_fts with exact-first ordering and a prefix filter', async () => {
    const { port, db } = await seeded()
    expect(port.symbolNamesByTokenSubstring('parser', null, 5)).toEqual([])

    writeFilesDelta(db, {
      removals: [],
      upserts: [fileUpsert('src/alpha/symbols.ts', ['symbols'])],
      graph: {
        byFile: new Map([
          ['src/alpha/symbols.ts', fileGraphDelta({
            symbols: [
              symbolRow('src/alpha/symbols.ts', 'routeRequestHandler', 'uid:rrh'),
              symbolRow('src/alpha/symbols.ts', 'RouteRequest', 'uid:rr'),
              symbolRow('src/alpha/symbols.ts', 'unrelated', 'uid:unrelated'),
            ],
          })],
        ]),
      },
    })
    const hits = port.symbolNamesByTokenSubstring('request', null, 10)
    // Case-insensitive exactness leads; the longer substring hit follows.
    expect(hits).toEqual([
      { filePath: 'src/alpha/symbols.ts', name: 'RouteRequest' },
      { filePath: 'src/alpha/symbols.ts', name: 'routeRequestHandler' },
    ])
    expect(port.symbolNamesByTokenSubstring('request', null, 1)).toEqual([hits[0]])
    expect(port.symbolNamesByTokenSubstring('request', 'src/beta', 10)).toEqual([])
    expect(port.symbolNamesByTokenSubstring('request', 'src/alpha', 10)).toEqual(hits)
    // LIKE metacharacters stay literal.
    expect(port.symbolNamesByTokenSubstring('r_q', null, 10)).toEqual([])
  })

  it('orders file-summary hits by bm25 with best (most negative) first and honors prefix + limit', async () => {
    const db = await openCodeIndexDatabase(':memory:')
    opened.push(db)
    writeFilesDelta(db, {
      removals: [],
      upserts: [
        { ...fileUpsert('src/light.ts', ['x']), summary: 'routing helper' },
        { ...fileUpsert('src/heavy.ts', ['y']), summary: 'routing request routing handler' },
        { ...fileUpsert('src/off.ts', ['z']), summary: 'unrelated' },
      ],
    }, { now: clock() })
    const port = createRetrievalPort(db)

    const hits = port.ftsFileSummaries('routing', null, 10)
    // Only summaries mentioning the token surface, in ascending raw-score
    // order (FTS5 orders negative-better first); length normalization decides
    // which of the two leads.
    expect(hits.map(hit => hit.filePath).sort()).toEqual(['src/heavy.ts', 'src/light.ts'])
    const scores = hits.map(hit => hit.rawScore)
    expect([...scores].sort((a, b) => a - b)).toEqual(scores)
    const best = hits[0]
    if (best === undefined) throw new Error('bm25 ordering fixture lost its hits')
    expect(best.rawScore).toBeLessThan(0)
    expect(hits.some(hit => hit.filePath === 'src/off.ts')).toBe(false)
    expect(port.ftsFileSummaries('routing', 'src/light', 10).map(hit => hit.filePath))
      .toEqual(['src/light.ts'])
    expect(port.ftsFileSummaries('routing', 'src/', 1)).toHaveLength(1)
    expect(port.ftsFileSummaries('absenttoken', null, 10)).toEqual([])
  })

  it('returns bm25-ordered lexical candidates carrying the file language and scope filters', async () => {
    const { port, db } = await seeded()
    // Dedicated fixture: one chunk repeats a token so term frequency ordering is observable.
    writeFilesDelta(db, {
      removals: [],
      upserts: [fileUpsert('src/dup/repeat.ts', [
        'repeatmarker repeatmarker repeatmarker cluster',
        'one repeatmarker only',
      ])],
    }, { now: clock() })

    const all = port.ftsChunkCandidates('routing OR payload', noScope, 10)
    expect(all.map(row => row.chunkId).sort()).toEqual([
      guideChunk(0),
      'chunk:src/alpha/parser.ts:0',
      'chunk:src/alpha/parser.ts:1',
      'chunk:src/beta/engine.ts:0',
    ])
    for (const candidate of all) {
      expect(candidate.languageName).toBe('typescript')
      expect(candidate.filePath).toContain('/')
    }
    // Term frequency orders candidates sharing one token: the chunk mentioning
    // it twice outranks the single mentions.
    const repeated = port.ftsChunkCandidates('repeatmarker', noScope, 10)
    expect(repeated[0]?.chunkId).toBe('chunk:src/dup/repeat.ts:0')
    expect(repeated).toHaveLength(2)

    expect(port.ftsChunkCandidates('engine', noScope, 10)[0]?.filePath).toBe('src/beta/engine.ts')
    expect(port.ftsChunkCandidates('routing', noScope, 1)).toHaveLength(1)
    expect(port.ftsChunkCandidates(
      'routing',
      { ...noScope, filePaths: ['src/beta/engine.ts'] },
      10,
    )).toEqual([])
    expect(port.ftsChunkCandidates(
      'routing',
      { ...noScope, filePaths: [['docs', 'readme.md'].join('/')] },
      10,
    ).map(row => row.chunkId)).toEqual([guideChunk(0)])
    expect(port.ftsChunkCandidates(
      'routing',
      { ...noScope, pathPrefix: 'src/alpha' },
      10,
    ).map(row => row.chunkId).sort()).toEqual([
      'chunk:src/alpha/parser.ts:0',
      'chunk:src/alpha/parser.ts:1',
    ])
    // Language scope routes through files.language; an absent language matches nothing.
    expect(port.ftsChunkCandidates(
      'routing',
      { ...noScope, languages: ['rust'] },
      10,
    )).toEqual([])
    expect(port.ftsChunkCandidates(
      'routing',
      { ...noScope, languages: ['typescript'] },
      10,
    )).toHaveLength(3)
    expect(port.ftsChunkCandidates('nomatch', noScope, 10)).toEqual([])
  })

  it('scans unscoped reads in recency order, decodes on demand, and stops on visitor false', async () => {
    const cache = new ChunkTextCache(64)
    const { port } = await seeded(cache)

    const visitedRows: string[] = []
    port.scanChunksForGrep(noScope, null, (row) => {
      visitedRows.push(row.chunkId)
      return false
    })
    // Newest write first — readme was stamped last.
    expect(visitedRows).toEqual([guideChunk(0)])
    expect(cache.stats().misses).toBe(1)

    let scanned = 0
    const seenTexts: string[] = []
    port.scanChunksForGrep(noScope, null, (row) => {
      scanned++
      seenTexts.push(row.text)
      return scanned < 3
    })
    expect(scanned).toBe(3)
    expect(seenTexts[seenTexts.length - 1]).toBe('alpha handles request routing')
    // The re-visited readme row came from the cache this time.
    expect(cache.stats().hits).toBeGreaterThanOrEqual(1)
  })

  it('skips listed chunk ids before paying any decode cost', async () => {
    const cache = new ChunkTextCache(64)
    const { port } = await seeded(cache)
    const ids = [guideChunk(0), 'chunk:src/alpha/parser.ts:1']
    let visited = 0
    port.scanChunksForGrep(noScope, new Set(ids), () => {
      visited++
      return true
    })
    expect(visited).toBe(2)
    // Only the two non-skipped rows were ever decoded.
    expect(cache.stats().misses).toBe(2)
  })

  it('decodes zstd-stored chunks transparently on the grep scan and detail paths', async () => {
    const db = await openCodeIndexDatabase(':memory:')
    opened.push(db)
    const compressedChunk = '原样解回 检索扫描 压缩存储 详情读取\n'.repeat(8)
    writeFilesDelta(
      db,
      { removals: [], upserts: [fileUpsert('src/zh/compressed.ts', [compressedChunk])] },
      { now: clock() },
    )
    expect(db.prepare('SELECT text_encoding FROM chunks WHERE chunk_id = ?')
      .get('chunk:src/zh/compressed.ts:0')).toMatchObject({ text_encoding: 'zstd' })

    const { port } = await createPort(db)
    const scanned: string[] = []
    port.scanChunksForGrep(noScope, null, (row) => {
      scanned.push(row.text)
      return true
    })
    expect(scanned).toEqual([compressedChunk])

    const prefilters: string[] = []
    port.scanChunksForGrepPrefiltered('"检索扫描"', 100, noScope, (row) => {
      prefilters.push(row.text)
      return true
    })
    expect(prefilters).toEqual([compressedChunk])

    const [detail] = port.chunkRowsByIds(['chunk:src/zh/compressed.ts:0'])
    expect(detail?.text).toBe(compressedChunk)
  })

  it('prefilters stage-one scans through chunks_fts MATCH with the scan cap as LIMIT', async () => {
    const { port } = await seeded()
    const hits: string[] = []
    port.scanChunksForGrepPrefiltered('"routing"', 100, noScope, (row) => {
      hits.push(row.chunkId)
      return true
    })
    expect(hits.sort()).toEqual([
      guideChunk(0),
      'chunk:src/alpha/parser.ts:0',
      'chunk:src/alpha/parser.ts:1',
    ])

    const capped: string[] = []
    port.scanChunksForGrepPrefiltered('"routing"', 1, noScope, (row) => {
      capped.push(row.chunkId)
      return true
    })
    expect(capped).toHaveLength(1)

    const scoped: string[] = []
    port.scanChunksForGrepPrefiltered('"routing"', 100, {
      ...noScope,
      pathPrefix: 'src/',
      languages: ['typescript'],
    }, (row) => {
      scoped.push(`${row.filePath} ${row.languageName}`)
      return true
    })
    expect(scoped).toEqual(['src/alpha/parser.ts typescript', 'src/alpha/parser.ts typescript'])

    const none: string[] = []
    port.scanChunksForGrepPrefiltered('"nonexistent"', 100, noScope, () => {
      none.push('hit')
      return true
    })
    expect(none).toEqual([])
  })

  it('keeps file-scoped grep scans in natural probe order without the recency sort', async () => {
    const { port } = await seeded()
    const scoped: string[] = []
    port.scanChunksForGrep({ ...noScope, filePaths: ['src/alpha/parser.ts', 'src/beta/engine.ts'] }, null, (row) => {
      scoped.push(row.chunkId)
      return true
    })
    expect(scoped.sort()).toEqual([
      'chunk:src/alpha/parser.ts:0',
      'chunk:src/alpha/parser.ts:1',
      'chunk:src/beta/engine.ts:0',
    ])

    const misses: string[] = []
    port.scanChunksForGrep({ ...noScope, filePaths: ['src/vacant.ts'] }, null, (row) => {
      misses.push(row.chunkId)
      return true
    })
    expect(misses).toEqual([])
  })

  it('batch-fetches full detail rows by id and decodes them through the cache', async () => {
    const cache = new ChunkTextCache(64)
    const { port } = await seeded(cache)
    const rows = port.chunkRowsByIds([
      'chunk:src/alpha/parser.ts:0',
      'chunk:src/vacant.ts:9',
      'chunk:src/beta/engine.ts:0',
    ])
    expect(rows).toHaveLength(2)
    const byId = new Map(rows.map(row => [row.chunkId, row]))
    const alpha = byId.get('chunk:src/alpha/parser.ts:0')
    expect(alpha).toMatchObject({
      filePath: 'src/alpha/parser.ts',
      languageName: 'typescript',
      startLine: 1,
      endLine: 10,
      breadcrumb: '',
      symbolName: null,
      symbolKind: null,
      text: 'alpha handles request routing',
    })
    // Second fetch serves the same rows from cache slots instead of decoding.
    port.chunkRowsByIds(['chunk:src/alpha/parser.ts:0', 'chunk:src/beta/engine.ts:0'])
    expect(cache.stats().hits).toBe(2)
    expect(cache.stats().misses).toBe(2)
  })

  it('answers literal FTS matches bm25-ordered with the scope filters applied', async () => {
    const { port, db } = await seeded()
    const literalCandidates = port.literalFtsCandidates?.bind(port)
    if (literalCandidates === undefined) throw new Error('literal mirror missing from the port')
    const literal = (filePath: string, literalId: string, text: string, kind: string): LiteralRowInput => ({
      literalId,
      filePath,
      literal: text,
      literalKind: kind,
      line: 7,
      container: 'buildUrl',
      confidence: 0.5,
      enclosingSymbolUid: null,
    })
    writeFilesDelta(db, {
      removals: [],
      upserts: [fileUpsert('src/dup/tokens.ts', ['route tokens live here'])],
      graph: {
        byFile: new Map([
          ['src/dup/tokens.ts', fileGraphDelta({
            literals: [
              literal('src/dup/tokens.ts', 'lit:dense', 'routetoken routetoken routetoken', 'route'),
              literal('src/dup/tokens.ts', 'lit:single', 'routetoken once', 'url'),
              literal('src/dup/tokens.ts', 'lit:other', 'unrelated', 'sql'),
            ],
          })],
        ]),
      },
    }, { now: clock() })

    const rows = literalCandidates('routetoken', noScope, 10)
    // Term frequency orders the matches; the non-matching literal is absent.
    expect(rows.map(row => row.literalId)).toEqual(['lit:dense', 'lit:single'])
    const byId = new Map(rows.map(row => [row.literalId, row]))
    expect(byId.get('lit:dense')?.literalKind).toBe('route')
    expect(byId.get('lit:single')?.literalKind).toBe('url')
    for (const row of rows) {
      expect(row.filePath).toBe('src/dup/tokens.ts')
      expect(row.literal).toContain('routetoken')
      expect(row.line).toBe(7)
      expect(row.container).toBe('buildUrl')
      expect(row.rank).toBeLessThan(0)
    }
    expect([...rows.map(row => row.rank)].sort((a, b) => a - b)).toEqual(rows.map(row => row.rank))

    // Path scopes stay literal (LIKE metacharacters escaped) and language/file scopes route through SQL.
    expect(literalCandidates('routetoken', { ...noScope, pathPrefix: 'src/dup' }, 10)).toHaveLength(2)
    expect(literalCandidates('routetoken', { ...noScope, pathPrefix: '%' }, 10)).toEqual([])
    expect(literalCandidates('routetoken', { ...noScope, languages: ['rust'] }, 10)).toEqual([])
    expect(literalCandidates('routetoken', { ...noScope, languages: ['typescript'] }, 10)).toHaveLength(2)
    expect(literalCandidates('routetoken', { ...noScope, filePaths: ['src/alpha/parser.ts'] }, 10)).toEqual([])
    expect(literalCandidates('nomatch', noScope, 10)).toEqual([])
    expect(literalCandidates('routetoken', noScope, 1)).toHaveLength(1)
  })
})


describe('vector read facet', () => {
  const opened: Array<import('node:sqlite').DatabaseSync> = []
  afterEach(() => {
    while (opened.length > 0) opened.pop()?.close()
  })

  /** Seed the two-chunk parser file and store its vectors under `embed-a`. */
  async function seededWithVectors(): Promise<{ port: ReturnType<typeof createRetrievalPort>; db: import('node:sqlite').DatabaseSync }> {
    const db = await openCodeIndexDatabase(':memory:')
    opened.push(db)
    writeFilesDelta(db, {
      removals: [],
      upserts: [fileUpsert('src/alpha/parser.ts', ['alpha handles request routing', 'alpha routing again'])],
    }, { now: clock() })
    for (const [chunkIndex, components] of [[0, [3, 0, 0]], [1, [1, 1, 0]]] as const) {
      const vector = quantizeInt8(Float32Array.from(components))
      writeChunkVectors(db, [{
        chunkId: `chunk:src/alpha/parser.ts:${chunkIndex}`,
        chunkRowid: chunkIndex + 1,
        model: 'embed-a',
        dim: 3,
        scale: vector.scale,
        q: new Uint8Array(vector.q.buffer),
        norm: vector.norm,
      }])
    }
    return { port: createRetrievalPort(db), db }
  }

  it('reads stored vectors byte-identical, filtering on model and dropping unknown ids', async () => {
    const { port } = await seededWithVectors()
    expect(port.vector).toBeDefined()
    const rows = port.vector?.vectorsByChunkIds(
      ['chunk:src/alpha/parser.ts:1', 'chunk:src/alpha/parser.ts:0', 'chunk:src/vacant.ts:0'],
      'embed-a',
    )
    expect(rows).toHaveLength(2)
    const first = rows?.find(row => row.chunkId === 'chunk:src/alpha/parser.ts:0')
    expect(first).toMatchObject({ rowid: 1, dim: 3 })
    // The stored bytes decode back to the original direction, not a lossy copy.
    const cosine = cosineQuantized(
      Float32Array.from([1, 0, 0]),
      first?.q as Uint8Array,
      first?.scale as number,
      first?.norm as number,
    )
    expect(cosine).toBeCloseTo(1, 5)
    // Another model's rows never leak through a foreign model query.
    expect(port.vector?.vectorsByChunkIds(['chunk:src/alpha/parser.ts:0'], 'embed-b')).toEqual([])
  })

  it('ranks stored rows by quantized cosine against a query vector', async () => {
    const { port } = await seededWithVectors()
    const query = Float32Array.from([0.9, 0.1, 0])
    const rows = port.vector?.vectorsByChunkIds(
      ['chunk:src/alpha/parser.ts:0', 'chunk:src/alpha/parser.ts:1'],
      'embed-a',
    ) ?? []
    const ranked = rows
      .map(row => ({ chunkId: row.chunkId, score: cosineQuantized(query, row.q, row.scale, row.norm) }))
      .sort((a, b) => b.score - a.score)
    expect(ranked.map(row => row.chunkId)).toEqual(['chunk:src/alpha/parser.ts:0', 'chunk:src/alpha/parser.ts:1'])
  })

  it('reports per-model coverage counts over the chunk tier', async () => {
    const { port, db } = await seededWithVectors()
    expect(port.vector?.vectorCoverage('embed-a')).toEqual({ vectorizedChunks: 2, totalChunks: 2 })
    expect(port.vector?.vectorCoverage('embed-b')).toEqual({ vectorizedChunks: 0, totalChunks: 2 })
    expect(readVectorCoverage(db, 'embed-a')).toEqual({ vectorizedChunks: 2, totalChunks: 2 })
  })
})
