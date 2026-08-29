import { afterEach, describe, expect, it } from 'vitest'
import { openCodeIndexDatabase } from '../src/open.ts'
import { createRetrievalPort } from '../src/reader.ts'
import { writeFilesDelta } from '../src/writer.ts'
import { readEpochs } from '../src/epoch.ts'
import { createSearchEngine, grepPrefilterPhrase, LANE_LITERAL_ID } from '@relay-harness/rlh-code-index-search'
import type { ChunkTextCache } from '../src/cache.ts'
import { clock, fileGraphDelta, fileUpsert } from './support.ts'

/**
 * Minimal real chain for the lexical + grep lanes: actual admission, actual
 * delta writes, then the search package's engine over the retrieval adapter.
 */
describe('retrieval port against the search engine', () => {
  const opened: Array<import('node:sqlite').DatabaseSync> = []
  afterEach(() => {
    while (opened.length > 0) opened.pop()?.close()
  })

  async function seededEngine(cache?: ChunkTextCache) {
    const db = await openCodeIndexDatabase(':memory:')
    opened.push(db)
    const result = writeFilesDelta(
      db,
      {
        removals: [],
        upserts: [
          fileUpsert('src/http/router.ts', [
            'export function routeRequest(request: Request) { return dispatch(request) }',
            'function dispatch(request: Request) { return handlerLookup(request.url) }',
          ]),
          fileUpsert('src/util/hash.ts', ['export function stableHash(input: string): number']),
        ],
      },
      { now: clock() },
    )
    expect(result.chunksWritten).toBe(3)
    const cacheInstance = cache
    const port = createRetrievalPort(db, cache === undefined ? {} : { cache })
    const engine = createSearchEngine({ port, resolveEpochs: () => readEpochs(db) })
    return { db, engine, epochsAfterWrite: readEpochs(db), cacheInstance }
  }

  it('runs the lexical lane end-to-end over written chunks', async () => {
    const { engine, epochsAfterWrite } = await seededEngine()
    const result = engine.search({ query: 'routeRequest dispatch' })

    expect(result.degraded).toBe(false)
    expect(result.readErrors).toEqual([])
    expect(result.tier).toBe('tiny')
    expect(result.candidateCount).toBeGreaterThan(0)
    expect(epochsAfterWrite).toEqual({ indexEpoch: 1, evidenceEpoch: 0, embeddingEpoch: 0 })
    expect(result.epochs).toEqual(epochsAfterWrite)
    expect(result.hits.length).toBeGreaterThan(0)
    const topHit = result.hits[0]
    expect(topHit?.chunkId.startsWith('chunk:src/http/router.ts')).toBe(true)
    expect(topHit?.filePath).toBe('src/http/router.ts')
    expect(topHit?.reasons.some(reason => reason.includes('lexical'))).toBe(true)
  })

  it('serves grep matches through decoded chunk text, including mid-token stage-2 hits', async () => {
    const { engine } = await seededEngine()
    // `teRequest` occurs mid-token inside `routeRequest`, invisible to the
    // tokenizer-driven prefilter, so the lane must reach its full scan.
    expect(grepPrefilterPhrase('routeRequest')).toContain('routeRequest')
    const result = engine.search({ query: 'teRequest' })
    expect(result.readErrors).toEqual([])
    const matched = result.hits.filter(hit => hit.chunkId.startsWith('chunk:src/http/router.ts'))
    expect(matched.length).toBeGreaterThan(0)
  })

  it('narrows results to an explicit path scope', async () => {
    const { engine } = await seededEngine()
    const scoped = engine.search({ query: 'stablehash', paths: ['src/http/router.ts'] })
    for (const hit of scoped.hits) {
      expect(hit.filePath).toBe('src/http/router.ts')
    }
    const targeted = engine.search({ query: 'stableHash', paths: ['src/util/hash.ts'] })
    expect(targeted.hits.map(hit => hit.chunkId)).toEqual(['chunk:src/util/hash.ts:0'])
    expect(targeted.hits[0]?.score).toBeGreaterThan(0)
  })

  it('keeps repeated greps cheap by serving decoded text from the shared cache', async () => {
    let calls = 0
    const countingCache = {
      get(key: string): string | undefined {
        calls++
        return underlying.get(key)
      },
      setIfFresh(key: string, value: string, fresh?: Parameters<ChunkTextCache['setIfFresh']>[2]): boolean {
        return underlying.setIfFresh(key, value, fresh)
      },
      stats(): ReturnType<ChunkTextCache['stats']> {
        return underlying.stats()
      },
    }
    const underlying = new (await import('../src/cache.ts')).ChunkTextCache(64)
    Object.defineProperty(countingCache, Symbol.toStringTag, { value: 'Object' })
    const { engine } = await seededEngine(countingCache as unknown as ChunkTextCache)

    engine.search({ query: 'handlerLookup' })
    engine.search({ query: 'handlerLookup' })
    // First search decodes three rows (grep scans + detail fetch); replays of
    // already-decoded rows are served without another decode.
    expect(calls).toBeGreaterThanOrEqual(3)
    expect(underlying.stats().hits).toBeGreaterThan(0)
  })

  it('fuses the literal lane end-to-end: literals rank their owning chunks', async () => {
    const { db, engine } = await seededEngine()
    writeFilesDelta(db, {
      removals: [],
      upserts: [fileUpsert('src/http/routes.ts', [
        'const usersLoginPath = "/api/users/login" handled by the router',
      ])],
      graph: {
        byFile: new Map([
          ['src/http/routes.ts', fileGraphDelta({
            literals: [{
              literalId: 'lit:login-route',
              filePath: 'src/http/routes.ts',
              literal: '/api/users/login',
              literalKind: 'route',
              line: 5,
              container: 'buildUrl',
              confidence: 0.782,
              enclosingSymbolUid: null,
            }],
          })],
        ]),
      },
    }, { now: clock() })

    const result = engine.search({ query: 'users login' })
    expect(result.degraded).toBe(false)
    expect(result.readErrors).toEqual([])
    const hit = result.hits.find(candidate => candidate.chunkId === 'chunk:src/http/routes.ts:0')
    // The literal's FTS vote reached fusion and was attributed to the chunk
    // whose span (lines 1-10) covers the literal's line.
    expect(hit?.reasons.some(reason => reason.startsWith(`${LANE_LITERAL_ID}@`))).toBe(true)
  })

  it('enforces the lang: DSL filter through the SQL scope over a multi-language store', async () => {
    const { db, engine } = await seededEngine()
    writeFilesDelta(db, {
      removals: [],
      upserts: [
        { ...fileUpsert('src/queue/worker.rs', ['pub fn pump_queue(messages: Vec<Message>)']), language: 'rust' },
        { ...fileUpsert('src/queue/relay.ts', ['export function pump_queue(messages: string[])']), language: 'typescript' },
      ],
    }, { now: clock() })

    const rust = engine.search({ query: 'lang:rust pump_queue' })
    expect(rust.hits.length).toBeGreaterThan(0)
    for (const hit of rust.hits) {
      expect(hit.filePath).toBe('src/queue/worker.rs')
    }

    // The language clause lives in the store scope, so the other language's
    // identical chunk text never surfaces as a candidate.
    const typescript = engine.search({ query: 'lang:typescript pump_queue' })
    expect(typescript.hits.length).toBeGreaterThan(0)
    for (const hit of typescript.hits) {
      expect(hit.filePath).toBe('src/queue/relay.ts')
    }

    // An unknown language name filters nothing (Language::from_name parity).
    const unknown = engine.search({ query: 'lang:klingon pump_queue' })
    expect(unknown.hits.map(hit => hit.filePath).sort()).toEqual(['src/queue/relay.ts', 'src/queue/worker.rs'])
  })

  it('enforces the lang: DSL filter on the literal lane scope', async () => {
    const { db, engine } = await seededEngine()
    const literal = (filePath: string, literalId: string, text: string, kind: string, line: number) => ({
      literalId,
      filePath,
      literal: text,
      literalKind: kind,
      line,
      container: null,
      confidence: 0.782,
      enclosingSymbolUid: null,
    })
    writeFilesDelta(db, {
      removals: [],
      upserts: [
        { ...fileUpsert('src/api/routes.rs', ['pub fn mount(router: Router)']), language: 'rust' },
        { ...fileUpsert('src/api/mount.ts', ['export function mount(router: Router)']), language: 'typescript' },
      ],
      graph: {
        byFile: new Map([
          ['src/api/routes.rs', fileGraphDelta({
            literals: [literal('src/api/routes.rs', 'lit:rs-route', '/api/users/list', 'route', 3)],
          })],
          ['src/api/mount.ts', fileGraphDelta({
            literals: [literal('src/api/mount.ts', 'lit:ts-route', '/api/users/list', 'route', 3)],
          })],
        ]),
      },
    }, { now: clock() })

    const rust = engine.search({ query: 'lang:rust users list' })
    for (const hit of rust.hits) {
      expect(hit.filePath).toBe('src/api/routes.rs')
    }
    expect(rust.hits.some(hit => hit.reasons.some(reason => reason.startsWith(`${LANE_LITERAL_ID}@`)))).toBe(true)
    const typescript = engine.search({ query: 'lang:typescript users list' })
    for (const hit of typescript.hits) {
      expect(hit.filePath).toBe('src/api/mount.ts')
    }
  })
})
