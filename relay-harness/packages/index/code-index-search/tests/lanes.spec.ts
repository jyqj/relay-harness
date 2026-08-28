import { describe, expect, it } from 'vitest'
import { DEFAULT_SEARCH_CONFIG } from '../src/config.ts'
import { LANE_GREP_ID, LANE_LEXICAL_ID, LANE_LITERAL_ID } from '../src/fusion.ts'
import { createGrepLane, grepPrefilterPhrase } from '../src/lanes.grep.ts'
import { createLexicalLane } from '../src/lanes.lexical.ts'
import { chunkOwningLine, createLiteralLane } from '../src/lanes.literal.ts'
import { SearchPlan } from '../src/plan.ts'
import { DEFAULT_RANKING_CONFIG } from '../src/config.ts'
import type { ChunkSpanRow } from '../src/port.ts'
import type { LaneContext, ReadErrorCollector } from '../src/types.ts'
import { InMemoryIndex } from './fake-index.ts'

const config = DEFAULT_SEARCH_CONFIG
const ranking = DEFAULT_RANKING_CONFIG
const gates = { symbolExactEnabled: false }

function buildContext(index: InMemoryIndex, query: string, searchConfig = config, readErrors?: ReadErrorCollector): LaneContext {
  const plan = SearchPlan.build({ port: index, request: { query }, searchConfig, ranking, tier: 'tiny' })
  return { port: index, plan, config: searchConfig, ranking, gates, readErrors: readErrors ?? { push() {} } }
}

describe('grepPrefilterPhrase (lanes.rs::grep_prefilter_phrase)', () => {
  it('joins alphanumeric runs into a quoted phrase, starred when the literal ends mid-token', () => {
    // Underscore is NOT alphanumeric: runs split, and the trailing run earns the star.
    expect(grepPrefilterPhrase('get_user')).toBe('"get user"*')
    expect(grepPrefilterPhrase('foo bar')).toBe('"foo bar"*')
    expect(grepPrefilterPhrase('find!')).toBe('"find"')
    expect(grepPrefilterPhrase('find().')).toBe('"find"')
  })

  it('returns null when no token has length >= 2', () => {
    expect(grepPrefilterPhrase('a b !')).toBeNull()
    expect(grepPrefilterPhrase('!!!')).toBeNull()
  })

  it('treats CJK characters as alphanumeric runs', () => {
    expect(grepPrefilterPhrase('用户登录!')).toBe('"用户登录"')
  })
})

describe('lexical lane', () => {
  it('ranks candidates best-first and filters through the plan scope', () => {
    const index = new InMemoryIndex()
      .addFile('src/auth.ts', '')
      .addFile('lib/other.ts', '')
      .addChunk({ chunkId: 'z-single', filePath: 'src/auth.ts', startLine: 1, endLine: 5, text: 'auth handler' })
      .addChunk({ chunkId: 'a-double', filePath: 'src/auth.ts', startLine: 6, endLine: 9, text: 'auth login page' })
      .addChunk({ chunkId: 'm-other', filePath: 'lib/other.ts', startLine: 1, endLine: 4, text: 'auth boundary' })
    const lane = createLexicalLane()
    const context = buildContext(index, 'auth login')
    const hits = lane.run(context)
    // Fake bm25 ordering: more matched OR-terms first, ties by chunkId asc.
    expect(hits.map(hit => hit.chunkId)).toEqual(['a-double', 'm-other', 'z-single'])
    expect(hits[0]?.score).toBe(1)
    expect(lane.laneId).toBe(LANE_LEXICAL_ID)
    expect(lane.weight(config)).toBe(config.lexicalWeight)
    expect(lane.isEnabled(context)).toBe(true)
    expect(lane.annotatesHits()).toBe(true)
    expect(lane.scoreSlot()).toBe('lexical')

    const scoped = SearchPlan.build({
      port: index,
      request: { query: 'auth', pathPrefix: 'lib/' },
      searchConfig: config,
      ranking,
      tier: 'tiny',
    })
    const scopedHits = lane.run({ ...context, plan: scoped })
    expect(scopedHits.map(hit => hit.chunkId)).toEqual(['m-other'])
  })

  it('short-circuits an empty sanitized MATCH phrase without touching the port', () => {
    const index = new InMemoryIndex()
      .addFile('src/a.ts', '')
      .addChunk({ chunkId: 'c0', filePath: 'src/a.ts', startLine: 1, endLine: 1, text: 'anything' })
    let probed = false
    ;(index as unknown as Record<string, unknown>).ftsChunkCandidates = () => {
      probed = true
      return []
    }
    expect(createLexicalLane().run(buildContext(index, '!!!'))).toEqual([])
    expect(probed).toBe(false)
  })

  it('drops FTS candidates that drifted outside the plan filters before ranking', () => {
    const index = new InMemoryIndex()
      .addFile('src/in.ts', '')
      .addFile('other/out.ts', '')
      .addChunk({ chunkId: 'c-in', filePath: 'src/in.ts', startLine: 1, endLine: 1, text: 'auth login page' })
      .addChunk({ chunkId: 'c-out', filePath: 'other/out.ts', startLine: 1, endLine: 1, text: 'auth login mirror' })
    ;(index as unknown as Record<string, unknown>).ftsChunkCandidates = () => [
      { chunkId: 'c-out', filePath: 'other/out.ts', languageName: 'typescript' },
      { chunkId: 'c-in', filePath: 'src/in.ts', languageName: 'typescript' },
    ]
    // Scoped context: the store "missed" the prefix filter on c-out.
    const scopedContext = buildContext(index, 'path:src auth')
    const hits = createLexicalLane().run(scopedContext)
    expect(hits.map(hit => hit.chunkId)).toEqual(['c-in'])
    expect(hits[0]?.score).toBe(1)
  })
})

describe('chunkOwningLine (literal line attribution)', () => {
  const spans: ChunkSpanRow[] = [
    { filePath: 'a.ts', chunkId: 'c-1', startLine: 1, endLine: 10 },
    { filePath: 'a.ts', chunkId: 'c-2', startLine: 21, endLine: 30 },
  ]

  it('picks the last span starting at or before the line, across gaps', () => {
    expect(chunkOwningLine(spans, 5)).toBe('c-1')
    expect(chunkOwningLine(spans, 15)).toBe('c-1')
    expect(chunkOwningLine(spans, 25)).toBe('c-2')
  })

  it('answers null before the first span starts and is order-independent', () => {
    expect(chunkOwningLine(spans, 0)).toBeNull()
    expect(chunkOwningLine([...spans].reverse(), 25)).toBe('c-2')
  })
})

describe('literal lane', () => {
  function seededIndex(): InMemoryIndex {
    const index = new InMemoryIndex()
      .addFile('src/http/routes.ts', '')
      .addFile('src/auth.ts', '')
    index.addChunk({ chunkId: 'c-routes', filePath: 'src/http/routes.ts', startLine: 1, endLine: 10, text: 'router mount body' })
    index.addChunk({ chunkId: 'c-auth', filePath: 'src/auth.ts', startLine: 1, endLine: 10, text: 'guard body' })
    index.graphData.chunkSpans.push(
      { filePath: 'src/http/routes.ts', chunkId: 'c-routes', startLine: 1, endLine: 10 },
      { filePath: 'src/auth.ts', chunkId: 'c-auth', startLine: 1, endLine: 10 },
    )
    index.graphData.literals.push(
      {
        literalId: 'lit-login', filePath: 'src/http/routes.ts', literal: '/api/users/login',
        literalKind: 'route', line: 5, container: null, confidence: 0.782, enclosingSymbolUid: null,
      },
      {
        literalId: 'lit-secret', filePath: 'src/http/routes.ts', literal: 'users secret key',
        literalKind: 'env_key', line: 6, container: null, confidence: 0.782, enclosingSymbolUid: null,
      },
      {
        literalId: 'lit-elsewhere', filePath: 'src/auth.ts', literal: 'unrelated text',
        literalKind: 'log_key', line: 2, container: null, confidence: 0.782, enclosingSymbolUid: null,
      },
    )
    return index
  }

  it('ranks the chunks owning matching literals best-first, one vote per chunk', () => {
    const index = seededIndex()
    const lane = createLiteralLane()
    const context = buildContext(index, 'users')
    const hits = lane.run(context)
    // Both matching literals share c-routes: the best (first) wins, the chunk
    // is reported once, and the non-matching file contributes nothing.
    expect(hits.map(hit => hit.chunkId)).toEqual(['c-routes'])
    expect(hits[0]?.score).toBe(1)
    expect(lane.laneId).toBe(LANE_LITERAL_ID)
    expect(lane.weight(config)).toBe(config.literalWeight)
    expect(lane.annotatesHits()).toBe(true)
    expect(lane.scoreSlot()).toBe('literal')
    expect(lane.isEnabled(context)).toBe(true)
  })

  it('filters candidates through the plan scope before attribution', () => {
    const index = seededIndex()
    const scoped = SearchPlan.build({
      port: index,
      request: { query: 'users', pathPrefix: 'src/auth' },
      searchConfig: config,
      ranking,
      tier: 'tiny',
    })
    expect(createLiteralLane().run({ ...buildContext(index, 'users'), plan: scoped })).toEqual([])
  })

  it('honors the literal top-K cap (limits.literal floors at the tier top-K)', () => {
    const index = new InMemoryIndex().addFile('src/bulk.ts', '')
    for (let i = 0; i < 7; i++) {
      index.addChunk({ chunkId: `c-marker-${i}`, filePath: 'src/bulk.ts', startLine: i * 40 + 1, endLine: i * 40 + 39, text: `filler ${i}` })
      index.graphData.chunkSpans.push({ filePath: 'src/bulk.ts', chunkId: `c-marker-${i}`, startLine: i * 40 + 1, endLine: i * 40 + 39 })
      index.graphData.literals.push({
        literalId: `lit-${i}`, filePath: 'src/bulk.ts', literal: `marker${i} token`,
        literalKind: 'log_key', line: i * 40 + 5, container: null, confidence: 0.782, enclosingSymbolUid: null,
      })
    }
    // limits.literal = max(literalTopK=2, tier top-K=5) = 5: seven matching
    // chunks are cut to five.
    const tightConfig = { ...DEFAULT_SEARCH_CONFIG, literalTopK: 2 }
    const hits = createLiteralLane().run(buildContext(index, 'marker token', tightConfig))
    expect(hits).toHaveLength(5)
    expect(hits.map(hit => hit.chunkId)).toEqual([
      'c-marker-0', 'c-marker-1', 'c-marker-2', 'c-marker-3', 'c-marker-4',
    ])
  })

  it('disables itself on ports without the literal mirror and skips sanitized-empty queries', () => {
    const stripped = seededIndex()
    // The fake implements the mirror on its prototype; a port predating the
    // mirror simply has no such property.
    ;(stripped as unknown as Record<string, unknown>).literalFtsCandidates = undefined
    const context = buildContext(stripped, 'users')
    expect(createLiteralLane().isEnabled(context)).toBe(false)
    expect(createLiteralLane().run(context)).toEqual([])

    const emptyQuery = createLiteralLane().run(buildContext(seededIndex(), '!!!'))
    expect(emptyQuery).toEqual([])
  })

  it('skips literals without a line, before every span, or in a span-less file', () => {
    const index = new InMemoryIndex().addFile('src/a.ts', '').addFile('src/spanless.ts', '')
    index.addChunk({ chunkId: 'c-a', filePath: 'src/a.ts', startLine: 100, endLine: 110, text: 'body' })
    index.graphData.chunkSpans.push({ filePath: 'src/a.ts', chunkId: 'c-a', startLine: 100, endLine: 110 })
    index.graphData.literals.push(
      {
        literalId: 'lit-no-line', filePath: 'src/a.ts', literal: 'users login', literalKind: 'log_key',
        line: null, container: null, confidence: 0.782, enclosingSymbolUid: null,
      },
      {
        literalId: 'lit-early', filePath: 'src/a.ts', literal: 'users signup', literalKind: 'route',
        line: 3, container: null, confidence: 0.782, enclosingSymbolUid: null,
      },
      {
        literalId: 'lit-unspanned', filePath: 'src/spanless.ts', literal: 'users checkout', literalKind: 'route',
        line: 4, container: null, confidence: 0.782, enclosingSymbolUid: null,
      },
    )
    expect(createLiteralLane().run(buildContext(index, 'users'))).toEqual([])
  })
})

describe('grep lane', () => {
  function seed(): InMemoryIndex {
    return new InMemoryIndex()
      .addFile('src/users.ts', '')
      .addFile('src/posts.ts', '')
      // rowid/ordering: later addChunk = higher rowid = more recent.
      .addChunk({ chunkId: 'stage-old', filePath: 'src/users.ts', startLine: 1, endLine: 4, breadcrumb: '', text: 'please load user profile' })
      .addChunk({ chunkId: 'stage-new', filePath: 'src/users.ts', startLine: 5, endLine: 8, text: 'cannot load user anymore' })
      .addChunk({ chunkId: 'nope', filePath: 'src/posts.ts', startLine: 1, endLine: 2, text: 'posts listing page' })
  }

  it('merges stage-1/stage-2 matches in recency order', () => {
    const seenPhrases: string[] = []
    const index = seed()
    const original = index.scanChunksForGrepPrefiltered.bind(index)
    ;(index as unknown as Record<string, unknown>).scanChunksForGrepPrefiltered = (
      phrase: string,
      scanCap: number,
      scope: Parameters<typeof original>[2],
      visit: Parameters<typeof original>[3],
    ) => {
      seenPhrases.push(phrase)
      original(phrase, scanCap, scope, visit)
    }
    const hits = createGrepLane().run(buildContext(index, 'load user'))
    expect(seenPhrases).toEqual(['"load user"*'])
    expect(hits.map(hit => hit.chunkId)).toEqual(['stage-new', 'stage-old'])
  })

  it('recovers tokenizer-invisible mid-token matches in stage 2', () => {
    const index = seed()
    index.addChunk({ chunkId: 'infix-newest', filePath: 'src/users.ts', startLine: 20, endLine: 30, text: 'internal getUserByIdImpl resolves cache' })
    const hits = createGrepLane().run(buildContext(index, 'erby'))
    // Only the regex stage can see 'serBy' inside 'getUserByIdImpl'.
    expect(hits.map(hit => hit.chunkId)).toEqual(['infix-newest'])
  })

  it('falls back to the full scan with a readError when the prefilter port call fails', () => {
    const index = seed()
    const errors: string[] = []
    ;(index as unknown as Record<string, unknown>).scanChunksForGrepPrefiltered = () => {
      throw new Error('fts hiccup')
    }
    const readErrors: ReadErrorCollector = { push: message => errors.push(message) }
    const hits = createGrepLane().run(buildContext(index, 'load user', config, readErrors))
    const joined = errors.join('\n')
    expect(joined).toContain('FTS prefilter failed')
    expect(joined).toContain('full scan')
    // Reset state means no double counting: results equal the single-pass answer.
    expect(hits.map(hit => hit.chunkId)).toEqual(['stage-new', 'stage-old'])
  })

  it('keeps single-pass behavior under an explicit file scope (stage 1 skipped)', () => {
    const index = seed()
    let prefilterCalls = 0
    ;(index as unknown as Record<string, unknown>).scanChunksForGrepPrefiltered = () => {
      prefilterCalls++
    }
    const plan = SearchPlan.build({
      port: index,
      request: { query: 'load user', paths: ['src/users.ts'] },
      searchConfig: config,
      ranking,
      tier: 'tiny',
    })
    expect(plan.hasFileScope()).toBe(true)
    const hits = createGrepLane().run({ port: index, plan, config, ranking, gates, readErrors: { push() {} } })
    expect(prefilterCalls).toBe(0)
    expect(hits.map(hit => hit.chunkId)).toEqual(['stage-new', 'stage-old'])
  })

  it('honors the shared decode budget across both stages', () => {
    const index = new InMemoryIndex().addFile('src/bulk.ts', '')
    for (let i = 0; i < 10; i++) {
      index.addChunk({ chunkId: `bulk-${i}`, filePath: 'src/bulk.ts', startLine: i * 10, endLine: i * 10 + 9, text: `filler block ${i}` })
    }
    const tightConfig = { ...DEFAULT_SEARCH_CONFIG, grepScanCap: 3 }
    const hits = createGrepLane().run(buildContext(index, 'filler block', tightConfig))
    // Budget of 3 decodes over a 10-row scope: only the three newest rows ever ran.
    expect(hits.map(hit => hit.chunkId)).toEqual(['bulk-9', 'bulk-8', 'bulk-7'])
  })

  it('stops with enough matches and skips stage 2 entirely (no wasted full scan)', () => {
    const index = new InMemoryIndex().addFile('src/bulk.ts', '')
    for (let i = 0; i < 14; i++) {
      index.addChunk({ chunkId: `bulk-${i}`, filePath: 'src/bulk.ts', startLine: i * 10, endLine: i * 10 + 9, text: `bulk marker ${i}` })
    }
    let stage2Calls = 0
    const original = index.scanChunksForGrep.bind(index)
    ;(index as unknown as Record<string, unknown>).scanChunksForGrep = (
      scope: Parameters<typeof original>[0],
      skip: Parameters<typeof original>[1],
      visit: Parameters<typeof original>[2],
    ) => {
      stage2Calls++
      original(scope, skip, visit)
    }
    // limits.grep = max(grepTopK=12, topK=5) = 12 < 14 matches → early stop.
    const hits = createGrepLane().run(buildContext(index, 'bulk marker'))
    expect(stage2Calls).toBe(0)
    expect(hits).toHaveLength(12)
    // Early stop keeps the store's recency order: newest twelve rows.
    expect(hits[0]?.chunkId).toBe('bulk-13')
    expect(hits.at(-1)?.chunkId).toBe('bulk-2')
  })

  it('re-checks plan filters on decoded rows even when the store scope missed them', () => {
    const index = seed()
    ;(index as unknown as Record<string, unknown>).scanChunksForGrepPrefiltered = (
      _phrase: string,
      _scanCap: number,
      _scope: unknown,
      visit: (row: { rowid: number; chunkId: string; filePath: string; languageName: string; text: string }) => boolean,
    ) => {
      visit({ rowid: 99, chunkId: 'out-of-plan', filePath: 'elsewhere/x.ts', languageName: 'typescript', text: 'please load user profile' })
    }
    const hits = createGrepLane().run(buildContext(index, 'path:src/users.ts load user'))
    // The foreign row was decoded+counted by the budget but filtered out; the
    // stage-2 merge still supplies the in-scope matches.
    expect(hits.map(hit => hit.chunkId)).toEqual(['stage-new', 'stage-old'])
  })

  it('degrades to an empty contribution with a readError when the full scan rejects', () => {
    const index = seed()
    const errors: string[] = []
    ;(index as unknown as Record<string, unknown>).scanChunksForGrepPrefiltered = () => {
      throw new Error('fts hiccup')
    }
    ;(index as unknown as Record<string, unknown>).scanChunksForGrep = () => {
      throw new Error('cursor closed')
    }
    const readErrors: ReadErrorCollector = { push: message => errors.push(message) }
    expect(createGrepLane().run(buildContext(index, 'load user', config, readErrors))).toEqual([])
    const joined = errors.join('\n')
    expect(joined).toContain('FTS prefilter failed')
    expect(joined).toContain('chunk scan failed')
  })

  it('reports metadata like every registered lane must, and disables under includeGrep=false', () => {
    const index = seed()
    const lane = createGrepLane()
    const base = buildContext(index, 'load user')
    expect(lane.laneId).toBe(LANE_GREP_ID)
    expect(lane.weight(config)).toBe(config.grepWeight)
    expect(lane.annotatesHits()).toBe(true)
    expect(lane.scoreSlot()).toBe('grep')
    expect(lane.isEnabled(base)).toBe(true)

    const offPlan = SearchPlan.build({
      port: index,
      request: { query: 'load user', includeGrep: false },
      searchConfig: config,
      ranking,
      tier: 'tiny',
    })
    expect(lane.isEnabled({ ...base, plan: offPlan })).toBe(false)
  })
})
