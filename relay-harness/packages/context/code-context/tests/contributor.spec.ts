/** Code-index recall injection through the step-context seam. */
import { createHash } from 'node:crypto'
import { Context } from '@relay-harness/cordis'
import type { Fiber } from '@relay-harness/cordis'
import ContextEngine, { EvidenceId, SourceId } from '@relay-harness/rlh-context-engine'
import { createUserMessage } from '@relay-harness/rlh-llm'
import type { UserMessage } from '@relay-harness/rlh-llm'
import { SessionId } from '@relay-harness/rlh-session'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CodeContextContributor } from '../src/contributor.ts'
import CodeContext from '../src/index.ts'
import type { Config } from '../src/index.ts'
import {
  hydrateRequests,
  resetStub,
  scripted,
  searchHit,
  searchResult,
  searchRequests,
  StubCodeIndex,
  workspaceRequests,
} from './stub-code-index.ts'
import type { HydrateChunksResult, SearchHit } from '@relay-harness/rlh-code-index'

const CWD = '/workspace'
const QUERY = 'where is the spool marker defined'

function step(ctx: Context, cwd: string, messages: UserMessage[], signal = new AbortController().signal) {
  return ctx.get('contextEngine')!.prepareStep({
    purpose: 'agent_step', messages, signal, cwd,
    caller: { sessionId: SessionId('code-test'), agentId: 'code-test', workspaceId: cwd, turn: 1, step: 1 },
  })
}

function userMessage(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function promptText(message: UserMessage): string {
  return message.content.map(block => (block.type === 'text' ? block.text : '')).join('')
}

const DEFAULT_SNIPPET = 'export const spoolMarker = true'

function entryFor(hit: SearchHit, text: string = DEFAULT_SNIPPET): string {
  return `### ${JSON.stringify(hit.filePath)}:${hit.startLine}-${hit.endLine}`
    + ` revision=${hit.contentHash} score=${hit.score}`
    + ` parser=${hit.parserTier}:${hit.parserConfidence}`
    + ` reasons=${JSON.stringify(hit.reasons)}`
    + `\n\`\`\`\n${text}\n\`\`\``
}

function hydrationFor(hits: readonly SearchHit[], texts: readonly string[]): HydrateChunksResult {
  return {
    chunks: hits.map((hit, index) => ({
      chunkId: hit.chunkId,
      filePath: hit.filePath,
      language: hit.language,
      contentHash: hit.contentHash,
      startLine: hit.startLine,
      endLine: hit.endLine,
      text: texts[index] ?? '',
      parserTier: hit.parserTier,
      parserConfidence: hit.parserConfidence,
      verification: 'source-verified',
    })),
    rejected: [],
    epochs: { indexEpoch: 7, evidenceEpoch: 0 },
  }
}

/** Harness with the stub provider, the engine, and an explicitly enabled plugin. */
async function harness(config: Config = {}): Promise<{ ctx: Context; service: Fiber }> {
  const ctx = new Context()
  await ctx.plugin(StubCodeIndex)
  await ctx.plugin(ContextEngine)
  const service = ctx.plugin(CodeContext, config)
  await service
  return { ctx, service }
}

/** Contributor under test over a fresh harness context, driven directly. */
async function contributorHarness(config: Config = {}): Promise<{ ctx: Context; contributor: CodeContextContributor }> {
  const ctx = new Context()
  await ctx.plugin(StubCodeIndex)
  return {
    ctx,
    contributor: new CodeContextContributor(ctx, {
      maxChars: config.maxChars ?? 65_536,
      maxHits: config.maxHits ?? 8,
      minQueryChars: config.minQueryChars ?? 8,
    }),
  }
}

function contribute(
  harness: { contributor: CodeContextContributor },
  messages: UserMessage[],
  signal = new AbortController().signal,
) {
  return harness.contributor.contribute({
    purpose: 'agent_step', messages, signal, cwd: CWD,
    caller: { sessionId: SessionId('code-test'), agentId: 'code-test', workspaceId: CWD, turn: 1, step: 1 },
  })
}

beforeEach(() => {
  resetStub()
})

describe('CodeContextContributor', () => {
  it('contributes nothing without direct user text or under the query floor', async () => {
    const unit = await contributorHarness()
    const pluginEcho = createUserMessage({
      content: [{ type: 'text', text: 'an echoed question long enough to search' }],
      source: { kind: 'plugin', plugin: 'fixture' },
    })
    await expect(contribute(unit, [
      userMessage('short'),
      pluginEcho,
      createUserMessage({
        content: [{ type: 'reasoning', text: 'a reasoning block long enough to search' }],
        source: { kind: 'user' },
      }),
    ])).resolves.toBeUndefined()
    expect(searchRequests).toEqual([])
  })

  it('recalls ranked hits into one message with revision-bound evidence and coverage', async () => {
    const unit = await contributorHarness()
    scripted.search = searchResult([
      searchHit({ rank: 1 }),
      searchHit({ rank: 2, chunkId: 'chunk:src/other.ts:1', filePath: 'src/other.ts', score: 17 }),
    ])
    const contributed = await contribute(unit, [userMessage(QUERY)])
    expect(workspaceRequests).toEqual([CWD])
    expect(contributed!.message.source).toEqual({
      kind: 'code-index',
      form: 'recall',
      version: 2,
      cwd: CWD,
      query: QUERY,
      hits: [
        {
          chunkId: 'chunk:src/file.ts:1',
          filePath: 'src/file.ts',
          language: 'typescript',
          contentHash: 'file-hash-v1',
          startLine: 1,
          endLine: 3,
          score: 42,
          scoreTrace: [{ label: 'rrf:lexical', value: 42 }],
          parserTier: 'tree-sitter',
          parserConfidence: 0.9,
          truncated: false,
        },
        {
          chunkId: 'chunk:src/other.ts:1',
          filePath: 'src/other.ts',
          language: 'typescript',
          contentHash: 'file-hash-v1',
          startLine: 1,
          endLine: 3,
          score: 17,
          scoreTrace: [{ label: 'rrf:lexical', value: 42 }],
          parserTier: 'tree-sitter',
          parserConfidence: 0.9,
          truncated: false,
        },
      ],
      epochs: { indexEpoch: 7, evidenceEpoch: 0 },
      hydrationEpochs: { indexEpoch: 7, evidenceEpoch: 0 },
    })
    const text = promptText(contributed!.message)
    expect(text).toContain('## Code-index recall')
    expect(text).toContain('untrusted data')
    expect(text).toContain(entryFor(searchHit({ rank: 1 })))
    expect(text).toContain(entryFor(searchHit({
      rank: 2,
      chunkId: 'chunk:src/other.ts:1',
      filePath: 'src/other.ts',
      score: 17,
    })))
    expect(contributed!.evidence).toHaveLength(2)
    expect(contributed!.evidence?.[0]).toMatchObject({
      evidenceId: EvidenceId('code-index:chunk:src/file.ts:1'),
      resource: { sourceId: SourceId('code-index'), key: 'chunk:src/file.ts:1', revision: 'file-hash-v1' },
      digest: createHash('sha256').update(DEFAULT_SNIPPET).digest('hex'),
      truncated: false,
      freshness: 'current',
      verification: 'verified',
      domain: {
        filePath: 'src/file.ts',
        contentHash: 'file-hash-v1',
        parserTier: 'tree-sitter',
        parserConfidence: 0.9,
        searchEpochs: { indexEpoch: 7, evidenceEpoch: 0 },
        hydrationEpochs: { indexEpoch: 7, evidenceEpoch: 0 },
      },
    })
    expect(contributed!.evidence?.[1]).toMatchObject({
      resource: { key: 'chunk:src/other.ts:1', revision: 'file-hash-v1' },
      digest: createHash('sha256').update(DEFAULT_SNIPPET).digest('hex'),
      verification: 'verified',
    })
    expect(contributed!.coverage).toMatchObject({
      searched: [QUERY],
      notSearched: [],
      completeness: 'bounded',
    })
    expect(contributed!.coverage?.rationale).toContain('source-revalidated')
    expect(searchRequests).toEqual([{ query: QUERY }])
    expect(hydrateRequests).toEqual([{
      chunkIds: ['chunk:src/file.ts:1', 'chunk:src/other.ts:1'],
    }])
  })

  it('narrows the search to the distinct @file mentions of the same text', async () => {
    const unit = await contributorHarness()
    scripted.search = searchResult([searchHit()])
    await contribute(unit, [
      userMessage('explain @src/a.ts and @"src/b c.ts" please'),
      userMessage('also @src/a.ts again'),
    ])
    expect(searchRequests).toEqual([
      { query: 'explain @src/a.ts and @"src/b c.ts" please\nalso @src/a.ts again', paths: ['src/a.ts', 'src/b c.ts'] },
    ])
  })

  it('renders source text and an empty reasons list when the answer carries none', async () => {
    const unit = await contributorHarness()
    const hit = searchHit({ rank: 1, reasons: [] })
    scripted.search = searchResult([hit])
    const contributed = await contribute(unit, [userMessage(QUERY)])
    expect(promptText(contributed!.message)).toContain(entryFor(hit))
  })

  it('clips source text after reserving a complete header and fence', async () => {
    const hit = searchHit({ rank: 1 })
    const fixedChars = Array.from(entryFor(hit, '')).length
    const unit = await contributorHarness({ maxChars: fixedChars + 10 })
    scripted.search = searchResult([hit])
    const contributed = await contribute(unit, [userMessage(QUERY)])
    expect(contributed!.message.source).toMatchObject({ hits: [{ truncated: true }] })
    const text = promptText(contributed!.message)
    expect(text).toContain(entryFor(hit, DEFAULT_SNIPPET.slice(0, 10)))
    expect(text).toContain('(showing 1 of 1 ranked candidates')
    expect(contributed!.evidence).toEqual([
      expect.objectContaining({
        evidenceId: EvidenceId('code-index:chunk:src/file.ts:1'),
        digest: createHash('sha256').update(DEFAULT_SNIPPET.slice(0, 10)).digest('hex'),
        truncated: true,
      }),
    ])
  })

  it('keeps a whole source entry exactly fitting the budget and drops the rest', async () => {
    const first = searchHit({ rank: 1 })
    const second = searchHit({ rank: 2, chunkId: 'chunk:src/other.ts:1', filePath: 'src/other.ts', score: 17 })
    const unit = await contributorHarness({ maxChars: Array.from(entryFor(first)).length })
    scripted.search = searchResult([first, second])
    const contributed = await contribute(unit, [userMessage(QUERY)])
    const text = promptText(contributed!.message)
    expect(text).toContain(entryFor(first))
    expect(text).toContain('(showing 1 of 2 ranked candidates')
    expect(contributed!.evidence).toHaveLength(1)
    expect(contributed!.evidence?.[0]).toMatchObject({ truncated: false })
  })

  it('clips multibyte source on code-point boundaries without replacement characters', async () => {
    const hit = searchHit({ rank: 1, filePath: 'src/路由.ts' })
    const source = '路由😀尾'
    const unit = await contributorHarness({ maxChars: Array.from(entryFor(hit, '')).length + 3 })
    scripted.search = searchResult([hit])
    scripted.hydrate = hydrationFor([hit], [source])
    const contributed = await contribute(unit, [userMessage(QUERY)])
    const text = promptText(contributed!.message)
    expect(text).toContain(entryFor(hit, '路由😀'))
    expect(text).toContain('(showing 1 of 1 ranked candidates')
    expect(text).not.toContain('�')
    expect(contributed!.evidence?.[0]).toMatchObject({
      truncated: true,
      digest: createHash('sha256').update('路由😀').digest('hex'),
    })
  })

  it('spends the remaining source budget in code points, so an astral character costs one', async () => {
    const first = searchHit({ rank: 1, chunkId: 'chunk:a.ts:1', filePath: 'a.ts' })
    const second = searchHit({ rank: 2, chunkId: 'chunk:b.ts:1', filePath: 'b.ts', score: 17 })
    const source = '𝄞'
    expect(Array.from(source).length).toBe(1)
    expect(source.length).toBe(2)
    const budget = Array.from(entryFor(first, source)).length + 1 + Array.from(entryFor(second, source)).length
    const unit = await contributorHarness({ maxChars: budget })
    scripted.search = searchResult([first, second])
    scripted.hydrate = hydrationFor([first, second], [source, source])
    const contributed = await contribute(unit, [userMessage(QUERY)])
    const text = promptText(contributed!.message)
    expect(text).toContain(`${entryFor(first, source)}\n${entryFor(second, source)}`)
    expect(contributed!.evidence).toHaveLength(2)
    expect(contributed!.evidence?.every(record => !record.truncated)).toBe(true)
    expect(text).not.toContain('(showing ')
  })

  it('cuts the ranked list at the hit budget', async () => {
    const unit = await contributorHarness({ maxHits: 2 })
    scripted.search = searchResult([
      searchHit({ rank: 1 }),
      searchHit({ rank: 2, chunkId: 'chunk:src/second.ts:1', filePath: 'src/second.ts', score: 30 }),
      searchHit({ rank: 3, chunkId: 'chunk:src/third.ts:1', filePath: 'src/third.ts', score: 11 }),
    ])
    const contributed = await contribute(unit, [userMessage(QUERY)])
    expect(contributed!.evidence).toHaveLength(2)
    expect(contributed!.message.source).toMatchObject({ hits: [{}, {}] })
    expect(promptText(contributed!.message)).toContain('(showing 2 of 3 ranked candidates')
  })

  it('omits stale hydration, records coverage, and never labels it verified', async () => {
    const unit = await contributorHarness()
    const stale = searchHit({ rank: 1 })
    const current = searchHit({ rank: 2, chunkId: 'chunk:src/current.ts:1', filePath: 'src/current.ts' })
    scripted.search = searchResult([stale, current])
    scripted.hydrate = {
      ...hydrationFor([current], [DEFAULT_SNIPPET]),
      rejected: [{ chunkId: stale.chunkId, state: 'stale', reason: 'source-revision-changed' }],
    }
    const warn = vi.spyOn(unit.ctx.logger, 'warn')
    const contributed = await contribute(unit, [userMessage(QUERY)])
    expect(promptText(contributed!.message)).not.toContain('"src/file.ts"')
    expect(promptText(contributed!.message)).toContain('"src/current.ts"')
    expect(contributed!.evidence).toHaveLength(1)
    expect(contributed!.coverage?.notSearched).toEqual([stale.chunkId])
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('stale or unavailable'),
      expect.objectContaining({ chunkIds: [stale.chunkId] }),
    )
    warn.mockRestore()
  })

  it('contains a hydration failure and contributes no search-directory fallback', async () => {
    const unit = await contributorHarness()
    scripted.search = searchResult([searchHit()])
    scripted.hydrate = new Error('source unavailable')
    const warn = vi.spyOn(unit.ctx.logger, 'warn')
    await expect(contribute(unit, [userMessage(QUERY)])).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('hydration failed'),
      expect.objectContaining({ reason: 'source unavailable' }),
    )
    warn.mockRestore()
  })

  it('drops a degraded answer with a structured warning instead of a fake no-hits message', async () => {
    const { ctx } = await harness()
    const warn = vi.spyOn(ctx.logger, 'warn')
    scripted.search = searchResult([], {
      degraded: true,
      readErrors: ['search: lane failed'],
    })
    await expect(step(ctx, CWD, [userMessage(QUERY)])).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain('degraded code-index answer')
    expect(warn.mock.calls[0]?.[1]).toEqual({
      query: QUERY,
      epochs: { indexEpoch: 7, evidenceEpoch: 0 },
      readErrors: ['search: lane failed'],
    })
    warn.mockRestore()
  })

  it('treats read errors without the degraded flag the same way', async () => {
    const unit = await contributorHarness()
    const warn = vi.spyOn(unit.ctx.logger, 'warn')
    scripted.search = searchResult([searchHit()], { readErrors: ['grep: partial'] })
    await expect(contribute(unit, [userMessage(QUERY)])).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ readErrors: ['grep: partial'] })
    warn.mockRestore()
  })

  it('renders the bounded no-hits message with a coverage record and no evidence', async () => {
    const unit = await contributorHarness()
    scripted.search = searchResult([])
    const contributed = await contribute(unit, [userMessage(QUERY)])
    expect(contributed!.message.source).toMatchObject({
      kind: 'code-index',
      form: 'recall',
      hits: [],
    })
    expect(promptText(contributed!.message)).toContain('matched no indexed chunks')
    expect(contributed!.evidence).toEqual([])
    expect(contributed!.coverage).toMatchObject({ searched: [QUERY], completeness: 'bounded' })
  })

  it('propagates an aborted search instead of reporting it', async () => {
    const unit = await contributorHarness()
    scripted.search = new Error('aborted mid-flight')
    const controller = new AbortController()
    controller.abort()
    await expect(contribute(unit, [userMessage(QUERY)], controller.signal))
      .rejects.toThrow('aborted mid-flight')
  })

  it('contains a failed search as a warning and contributes nothing', async () => {
    const unit = await contributorHarness()
    const warn = vi.spyOn(unit.ctx.logger, 'warn')
    scripted.search = new Error('store unavailable')
    await expect(contribute(unit, [userMessage(QUERY)])).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ reason: 'store unavailable' })
    warn.mockRestore()
  })

  it('names a non-error search rejection in the warning', async () => {
    const unit = await contributorHarness()
    const warn = vi.spyOn(unit.ctx.logger, 'warn')
    scripted.throwValue = 'store unavailable'
    await expect(contribute(unit, [userMessage(QUERY)])).resolves.toBeUndefined()
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ reason: 'store unavailable' })
    warn.mockRestore()
  })

  it('fails loud when the enabled injection has no code-index provider', async () => {
    const ctx = new Context()
    await ctx.plugin(ContextEngine)
    await ctx.plugin(CodeContext, {})
    await expect(step(ctx, CWD, [userMessage(QUERY)]))
      .rejects.toThrow('code-context: code-index recall injection requires a code-index provider')
  })

  it('registers the recall contributor once under its stable engine id', async () => {
    const { ctx } = await harness()
    expect(() => ctx.get('contextEngine')!.registerContributor({
      id: 'code-index-recall',
      contribute: () => Promise.resolve(undefined),
    })).toThrow('already registered')
  })

  it('registers nothing without an explicit config section', async () => {
    for (const config of [undefined, null] as const) {
      const ctx = new Context()
      await ctx.plugin(StubCodeIndex)
      await ctx.plugin(ContextEngine)
      await ctx.plugin(CodeContext, config)
      scripted.search = searchResult([searchHit()])
      await expect(step(ctx, CWD, [userMessage(QUERY)])).resolves.toBeUndefined()
    }
  })

  it('fills omitted budget fields from the defaults and rejects invalid ones', async () => {
    for (const [config, fragment] of [
      [{ maxChars: 0 }, 'maxChars'],
      [{ maxChars: 1.5 }, 'maxChars'],
      [{ maxHits: 0 }, 'maxHits'],
      [{ maxHits: 2.5 }, 'maxHits'],
      [{ minQueryChars: -1 }, 'minQueryChars'],
      [{ minQueryChars: 1.5 }, 'minQueryChars'],
    ] as const) {
      const ctx = new Context()
      expect(() => new CodeContext(ctx, config)).toThrow(`code-context: ${fragment}`)
    }

    const schema = new Context()
    await expect(schema.plugin(CodeContext, { maxChars: 1.5 })).rejects.toThrow('maxChars')
  })

  it('removes the contributor when the service fiber is disposed', async () => {
    const { ctx, service } = await harness()
    scripted.search = searchResult([searchHit()])
    await expect(step(ctx, CWD, [userMessage(QUERY)])).resolves.toBeDefined()
    await service.dispose()
    await expect(step(ctx, CWD, [userMessage(QUERY)])).resolves.toBeUndefined()
  })
})
