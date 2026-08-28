import { describe, expect, it } from 'vitest'
import type { SearchResult } from '@relay-harness/rlh-code-index'
import { DEFAULT_SEARCH_CONFIG } from '../src/config.ts'
import { createSearchEngine, defaultPreselectLayersForEngine, defaultRetrievalLanes } from '../src/engine.ts'
import { SearchEngineError, SEARCH_PORT_READ_FAILED, SEARCH_REQUEST_INVALID } from '../src/errors.ts'
import type { EngineSearchRequest, PreselectLayer, RetrievalLane } from '../src/types.ts'
import { InMemoryIndex } from './fake-index.ts'

/** Round every non-integer float to 6 decimals and pretty-print, locking reason order and shapes. */
function canonical(result: SearchResult): string {
  return JSON.stringify(
    result,
    (_key, value: unknown) =>
      typeof value === 'number' && !Number.isInteger(value) ? Number(value.toFixed(6)) : value,
    2,
  )
}

function flagshipIndex(): InMemoryIndex {
  const index = new InMemoryIndex()
    .addFile('src/auth/users.ts', 'authentication user helpers')
    .addFile('src/repo/user_repository.ts', 'user repository storage')
    .addFile('lib/shared.js', 'shared connection helpers')
    .addFile('other/shared.ts', 'connection helper twin')
    .addFile('README.md', 'project user guide readme')
    .addFile('design/adr/0002-user-models.md', 'user model decision record')
    .addSymbol('src/auth/users.ts', 'getUserById')
    .addSymbol('src/repo/user_repository.ts', 'loadUser')
    .addSymbol('lib/shared.js', 'connect')
    .addSymbol('other/shared.ts', 'connect')
  // Insertion order == recency order: later chunks are newer.
  index
    .addChunk({
      chunkId: 'chunk:src/auth/users.ts:0',
      filePath: 'src/auth/users.ts',
      startLine: 10,
      endLine: 14,
      breadcrumb: 'auth/users',
      symbolName: 'getUserById',
      text: 'export function getUserById(id) { return users[id] || null }',
    })
    .addChunk({
      chunkId: 'chunk:src/auth/users.ts:1',
      filePath: 'src/auth/users.ts',
      startLine: 15,
      endLine: 18,
      breadcrumb: '',
      text: '// 查询用户 by id 工具\nexport const userCache = new Map<string, User>()',
    })
    .addChunk({
      chunkId: 'chunk:src/repo/user_repository.ts:0',
      filePath: 'src/repo/user_repository.ts',
      startLine: 3,
      endLine: 7,
      breadcrumb: 'repo',
      symbolName: 'loadUser',
      text: 'export function loadUser(id) { return db.users.get(id) }',
    })
    .addChunk({
      chunkId: 'chunk:lib/shared.js:0',
      filePath: 'lib/shared.js',
      startLine: 1,
      endLine: 2,
      breadcrumb: '',
      symbolName: 'connect',
      text: 'export function connect() { return pool.connect() }',
    })
    .addChunk({
      chunkId: 'chunk:other/shared.ts:0',
      filePath: 'other/shared.ts',
      startLine: 1,
      endLine: 2,
      breadcrumb: '',
      symbolName: 'connect',
      text: 'export function connect() { return client.connect() }',
    })
    .addChunk({
      chunkId: 'chunk:README.md:0',
      filePath: 'README.md',
      startLine: 1,
      endLine: 3,
      breadcrumb: '',
      text: '# demo project user guide with usage notes',
    })
    .addChunk({
      chunkId: 'chunk:design/adr/0002-user-models.md:0',
      filePath: 'design/adr/0002-user-models.md',
      startLine: 1,
      endLine: 4,
      breadcrumb: '',
      text: 'ADR 0002 adopts user models everywhere in this codebase',
    })
  return index
}

describe('createSearchEngine().search — flagship canonical output', () => {
  const request: EngineSearchRequest = {
    query: 'getUserById',
    recentPaths: ['src/auth/users.ts'],
    boostFilePaths: ['lib/shared.js'],
    pinnedFilePaths: ['other/shared.ts'],
    overlayFilePaths: ['src/repo/user_repository.ts'],
  }
  const index = flagshipIndex()
  const { search } = createSearchEngine({ port: index })
  const result = search(request)

  it('locks the full deterministic answer as canonical JSON', () => {
    expect(canonical(result)).toMatchSnapshot()
  })

  it('ranks the direct identifier first and explains every component', () => {
    expect(result.tier).toBe('tiny')
    expect(result.hits[0]?.chunkId).toBe('chunk:src/auth/users.ts:0')
    // The grep lane's rank-1 lift overcomes c2's one-position lexical edge.
    expect(result.hits[0]?.reasons[0]).toBe('lexical@2')
    expect(result.hits[0]?.reasons).toContain('grep@1')
    // Deterministic re-run equals byte-for-byte.
    expect(canonical(search(request))).toBe(canonical(result))
  })

  it('carries caller-injected epochs verbatim', () => {
    const injected = createSearchEngine({
      port: index,
      resolveEpochs: () => ({ indexEpoch: 42, evidenceEpoch: 7 }),
    }).search(request)
    expect(injected.epochs).toEqual({ indexEpoch: 42, evidenceEpoch: 7 })

    const defaulted = createSearchEngine({ port: index }).search({ query: 'getUserById' })
    expect(defaulted.epochs).toEqual({ indexEpoch: 0, evidenceEpoch: 0 })
  })

  it('supports an explicit narrow scope (paths) and prefix filtering', () => {
    const scoped = createSearchEngine({ port: index }).search({
      query: 'getUserById',
      paths: ['src/repo/user_repository.ts'],
    })
    for (const hit of scoped.hits) {
      expect(hit.filePath).toBe('src/repo/user_repository.ts')
    }
    expect(scoped.degraded).toBe(false)

    const prefixed = createSearchEngine({ port: index }).search({ query: 'getUserById', pathPrefix: 'nope/' })
    expect(prefixed.hits).toEqual([])
    expect(prefixed.truncated).toBe(false)
  })

  it('turns off the grep lane through includeGrep without degrading', () => {
    const lexicalOnly = createSearchEngine({ port: flagshipIndex() }).search({
      query: 'getUserById',
      includeGrep: false,
    })
    expect(lexicalOnly.degraded).toBe(false)
    for (const hit of lexicalOnly.hits) {
      expect(hit.reasons.some(reason => reason.startsWith('grep@'))).toBe(false)
    }
  })
})

describe('engine safeguards', () => {
  it('rejects a port without countFiles at construction time', () => {
    try {
      createSearchEngine({ port: {} as unknown as InMemoryIndex })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as SearchEngineError).code).toBe(SEARCH_REQUEST_INVALID)
    }
  })

  it('rejects non-string queries and tier-resolution failures with structured codes', () => {
    const { search } = createSearchEngine({ port: flagshipIndex() })
    try {
      search({ query: 42 as unknown as string })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as SearchEngineError).code).toBe(SEARCH_REQUEST_INVALID)
    }

    const brokenPort = flagshipIndex()
    ;(brokenPort as unknown as Record<string, unknown>).countFiles = () => {
      throw new Error('locked')
    }
    try {
      createSearchEngine({ port: brokenPort }).search({ query: 'x' })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as SearchEngineError).code).toBe(SEARCH_PORT_READ_FAILED)
    }
  })

  it('drops candidates the detail fetch cannot fully resolve or that drifted out of scope', () => {
    const index = flagshipIndex()
    // Simulates concurrent writes between lane scans and the batch fetch,
    // under a 'src/' request prefix every seeded src/ chunk satisfies at
    // scan time: one candidate vanished, another moved outside the prefix.
    ;(index as unknown as Record<string, unknown>).chunkRowsByIds = (chunkIds: readonly string[]) =>
      InMemoryIndex.prototype.chunkRowsByIds.call(index, chunkIds)
        .filter(row => row.chunkId !== 'chunk:src/repo/user_repository.ts:0')
        .map(row => row.chunkId === 'chunk:src/auth/users.ts:0'
          ? { ...row, filePath: 'elsewhere/x.ts' }
          : row)
    const result = createSearchEngine({ port: index }).search({ query: 'getUserById', pathPrefix: 'src/' })
    expect(result.candidateCount).toBeGreaterThanOrEqual(3)
    // Only the untouched src/ chunk survives both drift modes.
    expect(result.hits.map(hit => hit.chunkId)).toEqual(['chunk:src/auth/users.ts:1'])
  })

  it('breaks fused-score ties on ascending chunk id', () => {
    const index = new InMemoryIndex()
      .addFile('src/p.ts', '')
      .addFile('src/q.ts', '')
      .addFile('src/z.ts', '')
      .addChunk({ chunkId: 'c-p', filePath: 'src/p.ts', startLine: 1, endLine: 1, breadcrumb: '', text: 'alpha then tiebreak, finished' })
      .addChunk({ chunkId: 'c-q', filePath: 'src/q.ts', startLine: 2, endLine: 2, breadcrumb: '', text: 'we say tiebreak alpha together' })
      .addChunk({ chunkId: 'c-z', filePath: 'src/z.ts', startLine: 3, endLine: 3, breadcrumb: '', text: 'alpha meets tiebreak, done' })
    // Weighted so that the lexical-only runner-up (`52/51`) and the
    // grep-only winner (`51/51`) fuse to the SAME total — RRF equality that
    // only the lexicographic chunk-id tie-break may order.
    const tieConfig = { ...DEFAULT_SEARCH_CONFIG, lexicalWeight: 52, grepWeight: 51 }
    ;(index as unknown as Record<string, unknown>).ftsChunkCandidates = () => [
      { chunkId: 'c-p', filePath: 'src/p.ts', languageName: 'typescript' },
      { chunkId: 'c-z', filePath: 'src/z.ts', languageName: 'typescript' },
    ]
    const result = createSearchEngine({ port: index, cfg: tieConfig }).search({ query: 'tiebreak alpha' })
    expect(result.candidateCount).toBe(3)
    expect(result.hits.map(hit => hit.chunkId)).toEqual(['c-p', 'c-q', 'c-z'])
    expect(result.hits[1]?.score).toBe(result.hits[2]?.score)
  })

  it('degrades into readErrors when a lane read fails mid-flight', () => {
    const index = flagshipIndex()
    ;(index as unknown as Record<string, unknown>).ftsChunkCandidates = () => {
      throw new Error('fts exploded')
    }
    const result = createSearchEngine({ port: index }).search({ query: 'getUserById' })
    expect(result.degraded).toBe(true)
    expect(result.readErrors.join('\n')).toContain('lexical lane failed')
    // Grep still contributed; the pipeline did not abort.
    expect(result.hits.length).toBeGreaterThan(0)
  })

  it('degrades when the post-fusion detail fetch fails entirely', () => {
    const index = flagshipIndex()
    ;(index as unknown as Record<string, unknown>).chunkRowsByIds = () => {
      throw new Error('decode unavailable')
    }
    const result = createSearchEngine({ port: index }).search({ query: 'getUserById' })
    expect(result.degraded).toBe(true)
    expect(result.readErrors.join('\n')).toContain('chunk detail fetch failed')
    expect(result.hits).toEqual([])
  })
})

describe('output-character budget (tier constant)', () => {
  it('cuts extra hits once the budget is spent and flags truncation', () => {
    const index = new InMemoryIndex()
      .addFile('src/big_a.ts', '')
      .addFile('src/big_b.ts', '')
      .addChunk({ chunkId: 'chunk:src/big_b.ts:0', filePath: 'src/big_b.ts', startLine: 1, endLine: 2, breadcrumb: '', text: 'needle haystack body '.repeat(450) })
      .addChunk({ chunkId: 'chunk:src/big_a.ts:0', filePath: 'src/big_a.ts', startLine: 1, endLine: 2, breadcrumb: '', text: 'needle stored record'.repeat(450) })
    // Adapter-facing knob: the default is the tier's 18000-char envelope; a
    // snippet-rendering provider tightens it so the cut is observable here.
    const { search } = createSearchEngine({ port: index, outputBudgetChars: () => 400 })
    const result = search({ query: 'needle' })
    expect(result.candidateCount).toBeGreaterThanOrEqual(2)
    expect(result.hits).toHaveLength(1)
    expect(result.truncated).toBe(true)

    // With the budget left at the tier constant both hits fit.
    const generous = createSearchEngine({ port: index }).search({ query: 'needle' })
    expect(generous.truncated).toBe(false)
    expect(generous.hits.length).toBeGreaterThan(1)
  })
})

describe('DSL filters and the literal lane through the engine', () => {
  function kindIndex(): InMemoryIndex {
    const index = new InMemoryIndex()
      .addFile('src/fn.ts', '')
      .addFile('src/type.ts', '')
    index
      .addChunk({ chunkId: 'c-fn', filePath: 'src/fn.ts', startLine: 1, endLine: 2, symbolName: 'doWork', symbolKind: 'function', text: 'doWork implementation body' })
      .addChunk({ chunkId: 'c-type', filePath: 'src/type.ts', startLine: 1, endLine: 2, symbolName: 'Shape', symbolKind: 'type_alias', text: 'Shape alias declaration body' })
    return index
  }

  it('retains only kind-matching hits, folding spaces to underscores', () => {
    const { search } = createSearchEngine({ port: kindIndex() })
    const result = search({ query: 'kind:"type alias" body' })
    expect(result.degraded).toBe(false)
    expect(result.hits.map(hit => hit.chunkId)).toEqual(['c-type'])
    // A kind filter without any symbol kinds keeps nothing.
    const bare = new InMemoryIndex().addFile('src/x.ts', '')
    bare.addChunk({ chunkId: 'c-x', filePath: 'src/x.ts', startLine: 1, endLine: 2, text: 'body' })
    expect(createSearchEngine({ port: bare }).search({ query: 'kind:function body' }).hits).toEqual([])
  })

  it('boosts name: matches, emits the dsl-name reason, and retains only matches', () => {
    const { search } = createSearchEngine({ port: kindIndex() })
    const result = search({ query: 'name:shape body' })
    expect(result.hits.map(hit => hit.chunkId)).toEqual(['c-type'])
    expect(result.hits[0]?.reasons).toContain('dsl-name:shape')
  })

  it('carries literal-only candidates into the window with literal@ reasons', () => {
    const index = flagshipIndex()
    index.graphData.chunkSpans.push({
      filePath: 'src/auth/users.ts',
      chunkId: 'chunk:src/auth/users.ts:1',
      startLine: 15,
      endLine: 18,
    })
    index.graphData.literals.push({
      literalId: 'lit-only',
      filePath: 'src/auth/users.ts',
      literal: 'https://api.example.com/zzqliteral',
      literalKind: 'url',
      line: 16,
      container: null,
      confidence: 0.782,
      enclosingSymbolUid: null,
    })
    const result = createSearchEngine({ port: index }).search({ query: 'zzqliteral' })
    // No lexical/grep term matches any chunk; only the literal vote carries
    // the chunk in, annotated by its lane.
    expect(result.degraded).toBe(false)
    const hit = result.hits.find(candidate => candidate.chunkId === 'chunk:src/auth/users.ts:1')
    expect(hit).toBeDefined()
    expect(hit?.reasons).toContain('literal@1')
  })
})

describe('composed graph wiring (the concrete lane lives in the graph package)', () => {  // Structural stand-in for `createGraphLane()`: fusion-only, weight from the
  // graph constants, no hit annotation — exactly the contract the real lane
  // implements.
  const graphLane: RetrievalLane = {
    laneId: 'graph',
    weight: config => config.graphWeight,
    isEnabled: context => context.config.graphWeight > 0,
    annotatesHits: () => false,
    scoreSlot: () => 'graph',
    run: () => [{ chunkId: 'chunk:src/repo/user_repository.ts:0', score: 1 }],
  }

  it('fuses a third lane by registration order without hit annotation', () => {
    const index = flagshipIndex()
    const plain = createSearchEngine({ port: index }).search({ query: 'connect' })
    const withGraph = createSearchEngine({ port: index, lanes: [...defaultRetrievalLanes(), graphLane] })
      .search({ query: 'connect' })

    // The graph lane's vote carries a chunk no lexical/grep term matches into
    // the fused window, and being fusion-only it emits no `graph@rank` reason.
    expect(plain.hits.some(hit => hit.chunkId === 'chunk:src/repo/user_repository.ts:0')).toBe(false)
    expect(withGraph.hits.some(hit => hit.chunkId === 'chunk:src/repo/user_repository.ts:0')).toBe(true)
    for (const hit of withGraph.hits) {
      expect(hit.reasons.some(reason => reason.startsWith('graph@'))).toBe(false)
    }
    expect(withGraph.degraded).toBe(false)
  })

  it('runs the composed layer registry so appended layers reach the preselect fold', () => {
    const index = new InMemoryIndex()
      .addFile('src/base.ts', '')
      .addFile('src/extra.ts', '')
      .addChunk({ chunkId: 'c-base', filePath: 'src/base.ts', startLine: 1, endLine: 2, breadcrumb: '', text: 'needle here' })
      .addChunk({ chunkId: 'c-extra', filePath: 'src/extra.ts', startLine: 1, endLine: 2, breadcrumb: '', text: 'needle too' })
    const neighborLayer: PreselectLayer = {
      name: 'stub-neighbor',
      readsPriorScores: () => true,
      score: () => [{ filePath: 'src/extra.ts', score: 1, reason: 'stub-neighbor' }],
    }

    const composed = createSearchEngine({
      port: index,
      layers: [...defaultPreselectLayersForEngine(), neighborLayer],
    }).search({ query: 'needle' })
    expect(composed.hits.find(hit => hit.chunkId === 'c-extra')?.reasons).toContain('stub-neighbor')

    // Without the layer option the built-in registry runs and the extra file
    // never earns a preselect bill entry.
    const builtin = createSearchEngine({ port: index }).search({ query: 'needle' })
    expect(builtin.hits.find(hit => hit.chunkId === 'c-extra')?.reasons).not.toContain('stub-neighbor')
  })
})
