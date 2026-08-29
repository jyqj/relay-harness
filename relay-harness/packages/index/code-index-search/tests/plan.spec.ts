import { describe, expect, it } from 'vitest'
import { DEFAULT_RANKING_CONFIG, DEFAULT_SEARCH_CONFIG } from '../src/config.ts'
import {
  LaneRanks,
  SearchPlan,
  augmentedQueryText,
  compareStrings,
  defaultPreselectLimit,
  laneStatsOf,
  languageFromName,
  matchesKind,
  parseDslLite,
} from '../src/plan.ts'
import type { LaneOutcome } from '../src/types.ts'
import { InMemoryIndex } from './fake-index.ts'

describe('LaneRanks', () => {
  it('indexes every lane but lists only annotating ones in collection order', () => {
    const outcomes: LaneOutcome[] = [
      { laneId: 'lexical', weight: 1, annotatesHits: true, scoreSlot: 'lexical', hits: [{ chunkId: 'l1', score: 1 }] },
      { laneId: 'graph', weight: 1, annotatesHits: false, scoreSlot: 'graph', hits: [{ chunkId: 'g1', score: 1 }] },
      { laneId: 'grep', weight: 1, annotatesHits: true, scoreSlot: 'grep', hits: [] },
    ]
    const ranks = LaneRanks.fromOutcomes(outcomes)
    expect(ranks.annotatingLanes.map(entry => entry.laneId)).toEqual(['lexical', 'grep'])
    expect(ranks.rank('lexical', 'l1')).toBe(1)
    expect(ranks.rank('graph', 'g1')).toBe(1)
    expect(ranks.rank('grep', 'unknown')).toBeUndefined()
    expect(ranks.rank('absent-lane', 'x')).toBeUndefined()
  })
})

describe('parseDslLite (dsl.rs::parse_search_dsl)', () => {
  const empty = { text: '', pathFilter: null, kindFilter: null, langFilter: null, nameFilter: null }

  it('returns empty input untouched', () => {
    expect(parseDslLite('')).toEqual(empty)
    expect(parseDslLite('   ')).toEqual(empty)
  })

  it('extracts bare and quoted path filters case-insensitively', () => {
    expect(parseDslLite('path:src/api getUserById')).toEqual({ ...empty, text: 'getUserById', pathFilter: 'src/api' })
    expect(parseDslLite('PATH:"my docs/guides" search terms')).toEqual({ ...empty, text: 'search terms', pathFilter: 'my docs/guides' })
    // A repeated key keeps its first value (the one divergence from the reference's last-wins).
    expect(parseDslLite('Path:a path:b')).toEqual({ ...empty, pathFilter: 'a' })
  })

  it('extracts kind, lang, and name filters with quoted values and case-insensitive keys', () => {
    expect(parseDslLite('kind:function handle_request')).toEqual({ ...empty, text: 'handle_request', kindFilter: 'function' })
    expect(parseDslLite('kind:"type alias" MyType')).toEqual({ ...empty, text: 'MyType', kindFilter: 'type alias' })
    expect(parseDslLite('Kind:function Lang:Rust search_term')).toEqual({
      ...empty, text: 'search_term', kindFilter: 'function', langFilter: 'Rust',
    })
    expect(parseDslLite('name:handle_request kind:function')).toEqual({ ...empty, kindFilter: 'function', nameFilter: 'handle_request' })
    expect(parseDslLite('kind:class lang:python')).toEqual({ ...empty, kindFilter: 'class', langFilter: 'python' })
    expect(parseDslLite('lang:python path:src/api kind:class UserService')).toEqual({
      ...empty, text: 'UserService', kindFilter: 'class', langFilter: 'python', pathFilter: 'src/api',
    })
  })

  it('ignores an empty filter value and leaves unknown keys as free text', () => {
    expect(parseDslLite('path: alone')).toEqual({ ...empty, text: 'alone' })
    expect(parseDslLite('kind: class Users')).toEqual({ ...empty, text: 'class Users' })
    // A bare value runs to the next whitespace, colons included (cc parity).
    expect(parseDslLite('lang:proto:buf rest')).toEqual({ ...empty, text: 'rest', langFilter: 'proto:buf' })
    // Only the four known keys parse; anything else stays searchable text.
    expect(parseDslLite('foo:bar kind:function')).toEqual({ ...empty, text: 'foo:bar', kindFilter: 'function' })
    expect(parseDslLite('kindness:strict')).toEqual({ ...empty, text: 'kindness:strict' })
  })

  it('recovers an unterminated quoted value by consuming to the end of the query (cc parity)', () => {
    expect(parseDslLite('kind:"type foo')).toEqual({ ...empty, kindFilter: 'type foo' })
    expect(parseDslLite('path:"src/my module')).toEqual({ ...empty, pathFilter: 'src/my module' })
    expect(parseDslLite('name:"UserService kind:function')).toEqual({ ...empty, nameFilter: 'UserService kind:function' })
  })
})

describe('matchesKind (dsl.rs::matches_kind)', () => {
  it('folds spaces to underscores on the filter and lowercases both sides', () => {
    expect(matchesKind('function', 'function')).toBe(true)
    expect(matchesKind('Function', 'function')).toBe(true)
    expect(matchesKind('type_alias', 'type_alias')).toBe(true)
    expect(matchesKind('type_alias', 'type alias')).toBe(true)
    expect(matchesKind('type_alias', 'Type Alias')).toBe(true)
    expect(matchesKind('class', 'function')).toBe(false)
  })
})

describe('languageFromName (Language::from_name)', () => {
  it('resolves canonical names and aliases case-insensitively', () => {
    expect(languageFromName('python')).toBe('python')
    expect(languageFromName('Python')).toBe('python')
    expect(languageFromName('py')).toBe('python')
    expect(languageFromName('ts')).toBe('typescript')
    expect(languageFromName('golang')).toBe('go')
    expect(languageFromName('yml')).toBe('yaml')
    expect(languageFromName('C#')).toBe('csharp')
  })

  it('answers null for unknown names so the filter drops instead of excluding everything', () => {
    expect(languageFromName('klingon')).toBeNull()
    expect(languageFromName('')).toBeNull()
  })
})

describe('defaultPreselectLimit (plan.rs vectors)', () => {
  it('uses the 60 floor and the tier multipliers verbatim', () => {
    expect(defaultPreselectLimit(10, null)).toBe(120)
    expect(defaultPreselectLimit(10, 'tiny')).toBe(120)
    expect(defaultPreselectLimit(10, 'small')).toBe(120)
    expect(defaultPreselectLimit(10, 'medium')).toBe(150)
    expect(defaultPreselectLimit(10, 'large')).toBe(200)
    expect(defaultPreselectLimit(20, 'large')).toBe(400)
    expect(defaultPreselectLimit(3, null)).toBe(60)
  })

  it('compares strings byte-wise for ASCII ids', () => {
    expect(compareStrings('a', 'b')).toBe(-1)
    expect(compareStrings('b', 'a')).toBe(1)
    expect(compareStrings('same', 'same')).toBe(0)
  })
})

describe('SearchPlan.build normalization', () => {
  function indexForTopK(): InMemoryIndex {
    return new InMemoryIndex().addFile('x/y.ts', '').addChunk({ chunkId: 'c:y', filePath: 'x/y.ts', startLine: 1, endLine: 2, text: 'value' })
  }

  it('caps topK by tier constant and derives per-lane limits', () => {
    const tinyCapped = SearchPlan.build({ port: indexForTopK(), request: { query: 'q', topK: 99 }, searchConfig: DEFAULT_SEARCH_CONFIG, ranking: DEFAULT_RANKING_CONFIG, tier: 'tiny' })
    expect(tinyCapped.limits()).toEqual({ topK: 5, lexical: 24, grep: 12, graph: 12, literal: 12, vector: 12, rerankWindow: 40 })

    const largeDefault = SearchPlan.build({ port: indexForTopK(), request: { query: 'q' }, searchConfig: DEFAULT_SEARCH_CONFIG, ranking: DEFAULT_RANKING_CONFIG, tier: 'large' })
    expect(largeDefault.limits()).toEqual({ topK: 20, lexical: 24, grep: 20, graph: 20, literal: 20, vector: 20, rerankWindow: 40 })

    // Zero/negative requested K falls back to the tier default too.
    const zeroRequested = SearchPlan.build({ port: indexForTopK(), request: { query: 'q', topK: 0 }, searchConfig: DEFAULT_SEARCH_CONFIG, ranking: DEFAULT_RANKING_CONFIG, tier: 'large' })
    expect(zeroRequested.limits().topK).toBe(20)

    const raised = SearchPlan.build({ port: indexForTopK(), request: { query: 'q', topK: 10 }, searchConfig: { ...DEFAULT_SEARCH_CONFIG, lexicalTopK: 8, grepTopK: 3, graphTopK: 4, literalTopK: 2, vectorTopK: 6, rerankWindow: 9 }, ranking: DEFAULT_RANKING_CONFIG, tier: 'small' })
    expect(raised.limits()).toEqual({ topK: 10, lexical: 10, grep: 10, graph: 10, literal: 10, vector: 10, rerankWindow: 10 })
  })

  it('keeps the raw query when every token was consumed as a filter value', () => {
    const onlyFilter = SearchPlan.build({ port: indexForTopK(), request: { query: 'path:only' }, searchConfig: DEFAULT_SEARCH_CONFIG, ranking: DEFAULT_RANKING_CONFIG, tier: 'tiny' })
    expect(onlyFilter.grepQuery()).toBe('path:only')
    expect(onlyFilter.request.pathPrefix).toBe('only')
    expect(onlyFilter.lexicalQuery()).toBe('path:only')
  })

  it('biases lexical/preselect/overlap with the newest four distinct conversation queries', () => {
    const request = {
      query: ' primary ',
      conversationQueries: ['oldest-cut', ' fourth ', 'primary', '', 'third', 'second', ' newest '],
    }
    expect(augmentedQueryText(request)).toBe('primary\nnewest\nsecond\nthird')
    const plan = SearchPlan.build({
      port: indexForTopK(),
      request,
      searchConfig: DEFAULT_SEARCH_CONFIG,
      ranking: DEFAULT_RANKING_CONFIG,
      tier: 'tiny',
    })
    expect(plan.augmentedQuery).toBe('primary\nnewest\nsecond\nthird')
    expect(plan.lexicalQuery()).toContain('newest')
    expect(plan.queryTokens()).toEqual(['primary', 'newest', 'second', 'third'])
    expect(plan.grepQuery()).toBe('primary')
  })

  it('finalizeResults sorts score desc with chunkId-asc ties and cuts to explicit limits', () => {
    const plan = SearchPlan.build({ port: indexForTopK(), request: { query: 'q' }, searchConfig: DEFAULT_SEARCH_CONFIG, ranking: DEFAULT_RANKING_CONFIG, tier: 'tiny' })
    const ordered = plan.finalizeResults([
      { chunkId: 'zz-b', score: 1 },
      { chunkId: 'aa-a', score: 1 },
      { chunkId: 'top', score: 9 },
      { chunkId: 'cut', score: 0.5 },
    ], 3)
    expect(ordered.map(entry => entry.chunkId)).toEqual(['top', 'aa-a', 'zz-b'])
    // Default cut uses the plan's normalized top-K.
    expect(plan.finalizeResults([{ chunkId: 'x', score: 1 }])).toHaveLength(1)
  })

  it('finalizeResults retains only kind-matching candidates, dropping the symbol-less ones', () => {
    const withKinds = SearchPlan.build({ port: indexForTopK(), request: { query: 'kind:type_alias q' }, searchConfig: DEFAULT_SEARCH_CONFIG, ranking: DEFAULT_RANKING_CONFIG, tier: 'tiny' })
    expect(withKinds.filters.kinds).toEqual(['type_alias'])
    expect(withKinds.finalizeResults([
      { chunkId: 'a', score: 3, symbolKind: 'type_alias' },
      { chunkId: 'b', score: 2, symbolKind: 'TYPE_ALIAS' },
      { chunkId: 'c', score: 9, symbolKind: 'function' },
      { chunkId: 'd', score: 8 },
      { chunkId: 'e', score: 7, symbolKind: null },
    ])).toEqual([
      { chunkId: 'a', score: 3, symbolKind: 'type_alias' },
      { chunkId: 'b', score: 2, symbolKind: 'TYPE_ALIAS' },
    ])
    // No kind filter leaves everything, including symbol-less candidates.
    const plan = SearchPlan.build({ port: indexForTopK(), request: { query: 'q' }, searchConfig: DEFAULT_SEARCH_CONFIG, ranking: DEFAULT_RANKING_CONFIG, tier: 'tiny' })
    expect(plan.finalizeResults([{ chunkId: 'd', score: 8 }])).toHaveLength(1)
  })

  it('finalizeResults boosts and retains name matches with a dsl-name reason', () => {
    const withName = SearchPlan.build({ port: indexForTopK(), request: { query: 'name:handle_req q' }, searchConfig: DEFAULT_SEARCH_CONFIG, ranking: DEFAULT_RANKING_CONFIG, tier: 'tiny' })
    type Interim = { chunkId: string; score: number; symbolName?: string; reasons?: readonly string[] }
    const results: Interim[] = [
      { chunkId: 'a', score: 1, symbolName: 'Handle_Request', reasons: ['lexical@1'] },
      { chunkId: 'b', score: 5, symbolName: 'unrelated' },
      { chunkId: 'c', score: 9 },
      { chunkId: 'd', score: 0.5, symbolName: 'my_handle_request' },
    ]
    expect(withName.finalizeResults(results)).toEqual([
      { chunkId: 'a', score: 1.25, symbolName: 'Handle_Request', reasons: ['lexical@1', 'dsl-name:handle_req'] },
      { chunkId: 'd', score: 0.75, symbolName: 'my_handle_request', reasons: ['dsl-name:handle_req'] },
    ])
    // Input untouched: finalization works on copies.
    expect(results[0]?.score).toBe(1)
  })

  it('merges a DSL path filter into an absent prefix and keeps caller prefix precedence', () => {
    const merged = SearchPlan.build({ port: indexForTopK(), request: { query: 'path:x value' }, searchConfig: DEFAULT_SEARCH_CONFIG, ranking: DEFAULT_RANKING_CONFIG, tier: 'tiny' })
    expect(merged.request.query).toBe('value')
    expect(merged.request.pathPrefix).toBe('x')
    expect(merged.hasFileScope()).toBe(false)

    const kept = SearchPlan.build({ port: indexForTopK(), request: { query: 'path:dsl kept', pathPrefix: 'caller/' }, searchConfig: DEFAULT_SEARCH_CONFIG, ranking: DEFAULT_RANKING_CONFIG, tier: 'tiny' })
    expect(kept.request.pathPrefix).toBe('caller/')
  })

  it('materializes filters and scope from explicit paths, treating empty scope as absent', () => {
    const scoped = SearchPlan.build({ port: indexForTopK(), request: { query: 'v', paths: ['x/y.ts'] }, searchConfig: DEFAULT_SEARCH_CONFIG, ranking: DEFAULT_RANKING_CONFIG, tier: 'tiny' })
    expect(scoped.hasFileScope()).toBe(true)
    expect(scoped.chunkScope()).toEqual({ pathPrefix: null, languages: null, filePaths: ['x/y.ts'] })
    expect(scoped.passesFilters('x/y.ts')).toBe(true)
    expect(scoped.passesFilters('x/z.ts')).toBe(false)

    const emptied = SearchPlan.build({ port: indexForTopK(), request: { query: 'v', paths: [] }, searchConfig: DEFAULT_SEARCH_CONFIG, ranking: DEFAULT_RANKING_CONFIG, tier: 'tiny' })
    expect(emptied.hasFileScope()).toBe(false)
    expect(emptied.passesFilters('anywhere/file.ts')).toBe(true)

    const prefixed = SearchPlan.build({ port: indexForTopK(), request: { query: 'v', pathPrefix: 'lib/' }, searchConfig: DEFAULT_SEARCH_CONFIG, ranking: DEFAULT_RANKING_CONFIG, tier: 'tiny' })
    expect(prefixed.passesFilters('lib/in.ts')).toBe(true)
    expect(prefixed.passesFilters('other/out.ts')).toBe(false)
  })

  it('routes the lang: DSL filter into the chunk scope, dropping unknown names', () => {
    const resolved = SearchPlan.build({ port: indexForTopK(), request: { query: 'lang:py value' }, searchConfig: DEFAULT_SEARCH_CONFIG, ranking: DEFAULT_RANKING_CONFIG, tier: 'tiny' })
    expect(resolved.filters.languages).toEqual(['python'])
    expect(resolved.chunkScope()).toEqual({ pathPrefix: null, languages: ['python'], filePaths: null })

    const unknown = SearchPlan.build({ port: indexForTopK(), request: { query: 'lang:klingon value' }, searchConfig: DEFAULT_SEARCH_CONFIG, ranking: DEFAULT_RANKING_CONFIG, tier: 'tiny' })
    expect(unknown.filters.languages).toBeNull()
    expect(unknown.chunkScope().languages).toBeNull()

    const plain = SearchPlan.build({ port: indexForTopK(), request: { query: 'value' }, searchConfig: DEFAULT_SEARCH_CONFIG, ranking: DEFAULT_RANKING_CONFIG, tier: 'tiny' })
    expect(plain.filters).toEqual({ pathPrefix: null, languages: null, filePaths: null, kinds: null, name: null })
  })

  it('wires recentPaths into the preselect layer context and surfaces stats', () => {
    const index = new InMemoryIndex()
      .addFile('recent-one.ts', '')
      .addFile('no-hit.ts', '')
    const plan = SearchPlan.build({ port: index, request: { query: 'zzznothere', recentPaths: ['recent-one.ts'] }, searchConfig: DEFAULT_SEARCH_CONFIG, ranking: DEFAULT_RANKING_CONFIG, tier: 'tiny' })
    expect(plan.preselectResult.scores.get('recent-one.ts')).toBeCloseTo(3.5)
    expect(laneStatsOf(plan)).toMatchObject({ usedFallback: false, tokenHits: 0 })
    expect(plan.grepQuery()).toBe('zzznothere')
    expect(plan.lexicalQuery()).toBe('zzznothere')
    expect(plan.queryTokens()).toEqual(['zzznothere'])
  })
})
