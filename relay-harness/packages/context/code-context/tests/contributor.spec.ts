/** Code-index recall injection through the step-context seam. */
import { createHash } from 'node:crypto'
import { Context } from '@relay-harness/cordis'
import type { Fiber } from '@relay-harness/cordis'
import ContextEngine, { EvidenceId, SourceId } from '@relay-harness/rlh-context-engine'
import { createUserMessage } from '@relay-harness/rlh-llm'
import type { UserMessage } from '@relay-harness/rlh-llm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CodeContextContributor } from '../src/contributor.ts'
import CodeContext from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { resetStub, scripted, searchHit, searchResult, searchRequests, StubCodeIndex } from './stub-code-index.ts'

const CWD = '/workspace'
const QUERY = 'where is the spool marker defined'

function step(ctx: Context, cwd: string, messages: UserMessage[], signal = new AbortController().signal) {
  return ctx.get('contextEngine')!.prepareStep({ messages, signal, cwd })
}

function userMessage(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function promptText(message: UserMessage): string {
  return message.content.map(block => (block.type === 'text' ? block.text : '')).join('')
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
  return harness.contributor.contribute({ messages, signal, cwd: CWD })
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
    expect(contributed!.message.source).toEqual({
      kind: 'code-index',
      form: 'recall',
      version: 1,
      cwd: CWD,
      query: QUERY,
      hits: [
        {
          chunkId: 'chunk:src/file.ts:1',
          filePath: 'src/file.ts',
          startLine: 1,
          endLine: 3,
          score: 42,
          truncated: false,
        },
        {
          chunkId: 'chunk:src/other.ts:1',
          filePath: 'src/other.ts',
          startLine: 1,
          endLine: 3,
          score: 17,
          truncated: false,
        },
      ],
      epochs: { indexEpoch: 7, evidenceEpoch: 0 },
    })
    const text = promptText(contributed!.message)
    expect(text).toContain('## Code-index recall')
    expect(text).toContain('untrusted search output')
    expect(text).toContain('<code-index-recall>\nsrc/file.ts:1-3 42 lexical:fts\nsrc/other.ts:1-3 17 lexical:fts\n</code-index-recall>')
    const firstLine = 'src/file.ts:1-3 42 lexical:fts'
    expect(contributed!.evidence).toEqual([
      {
        evidenceId: EvidenceId('code-index:chunk:src/file.ts:1'),
        resource: { sourceId: SourceId('code-index'), key: 'chunk:src/file.ts:1', revision: '7' },
        digest: createHash('sha256').update(firstLine).digest('hex'),
        truncated: false,
        freshness: 'current',
        verification: 'unverified',
        domain: {
          filePath: 'src/file.ts',
          startLine: 1,
          endLine: 3,
          score: 42,
          reasons: ['lexical:fts'],
          parserTier: 'tree-sitter',
          epochs: { indexEpoch: 7, evidenceEpoch: 0 },
        },
      },
      {
        evidenceId: EvidenceId('code-index:chunk:src/other.ts:1'),
        resource: { sourceId: SourceId('code-index'), key: 'chunk:src/other.ts:1', revision: '7' },
        digest: createHash('sha256').update('src/other.ts:1-3 17 lexical:fts').digest('hex'),
        truncated: false,
        freshness: 'current',
        verification: 'unverified',
        domain: {
          filePath: 'src/other.ts',
          startLine: 1,
          endLine: 3,
          score: 17,
          reasons: ['lexical:fts'],
          parserTier: 'tree-sitter',
          epochs: { indexEpoch: 7, evidenceEpoch: 0 },
        },
      },
    ])
    expect(contributed!.coverage).toMatchObject({
      searched: [QUERY],
      notSearched: [],
      completeness: 'bounded',
    })
    expect(contributed!.coverage?.rationale).toContain('bounded by the configured')
    expect(searchRequests).toEqual([{ query: QUERY }])
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

  it('renders hit lines without a reasons suffix when the answer carries none', async () => {
    const unit = await contributorHarness()
    scripted.search = searchResult([searchHit({ rank: 1, reasons: [] })])
    const contributed = await contribute(unit, [userMessage(QUERY)])
    expect(promptText(contributed!.message)).toContain('<code-index-recall>\nsrc/file.ts:1-3 42\n</code-index-recall>')
  })

  it('truncates the first line at a tiny budget and drops the rest', async () => {
    const unit = await contributorHarness({ maxChars: 10 })
    scripted.search = searchResult([
      searchHit({ rank: 1 }),
      searchHit({ rank: 2, chunkId: 'chunk:src/other.ts:1', filePath: 'src/other.ts', score: 17 }),
    ])
    const contributed = await contribute(unit, [userMessage(QUERY)])
    expect(contributed!.message.source).toMatchObject({ hits: [{ truncated: true }] })
    const text = promptText(contributed!.message)
    expect(text).toContain('<code-index-recall>\nsrc/file.t\n')
    expect(text).toContain('(showing 1 of 2 ranked candidates')
    expect(contributed!.evidence).toEqual([
      expect.objectContaining({
        evidenceId: EvidenceId('code-index:chunk:src/file.ts:1'),
        digest: createHash('sha256').update('src/file.t').digest('hex'),
        truncated: true,
      }),
    ])
  })

  it('keeps a whole line exactly fitting the budget and drops the rest', async () => {
    const unit = await contributorHarness({ maxChars: 'src/file.ts:1-3 42 lexical:fts'.length })
    scripted.search = searchResult([
      searchHit({ rank: 1 }),
      searchHit({ rank: 2, chunkId: 'chunk:src/other.ts:1', filePath: 'src/other.ts', score: 17 }),
    ])
    const contributed = await contribute(unit, [userMessage(QUERY)])
    const text = promptText(contributed!.message)
    expect(text).toContain('src/file.ts:1-3 42 lexical:fts\n')
    expect(text).toContain('(showing 1 of 2 ranked candidates')
    expect(contributed!.evidence).toHaveLength(1)
    expect(contributed!.evidence?.[0]).toMatchObject({ truncated: false })
  })

  it('clips multibyte lines on code-point boundaries without replacement characters', async () => {
    const unit = await contributorHarness({ maxChars: 'src/'.length + 1 })
    scripted.search = searchResult([searchHit({ rank: 1, filePath: 'src/路由.ts' })])
    const contributed = await contribute(unit, [userMessage(QUERY)])
    const text = promptText(contributed!.message)
    expect(text).toContain('<code-index-recall>\nsrc/路\n')
    expect(text).toContain('(showing 1 of 1 ranked candidates')
    expect(text).not.toContain('�')
    expect(contributed!.evidence?.[0]).toMatchObject({
      truncated: true,
      digest: createHash('sha256').update('src/路').digest('hex'),
    })
  })

  it('spends the remaining budget in code points, so an astral character costs one', async () => {
    // '𝄞.ts:1-3 42 lexical:fts' is 23 code points but 24 UTF-16 units; two
    // such lines fit a 46 code-point budget exactly, with nothing truncated.
    const line1 = '𝄞.ts:1-3 42 lexical:fts'
    expect(Array.from(line1).length).toBe(23)
    expect(line1.length).toBe(24)
    const unit = await contributorHarness({ maxChars: 46 })
    scripted.search = searchResult([
      searchHit({ rank: 1, chunkId: 'chunk:𝄞.ts:1', filePath: '𝄞.ts' }),
      searchHit({ rank: 2, chunkId: 'chunk:src/b.ts:1', filePath: 'b.ts', score: 17 }),
    ])
    const contributed = await contribute(unit, [userMessage(QUERY)])
    const text = promptText(contributed!.message)
    expect(text).toContain(`<code-index-recall>\n${line1}\nb.ts:1-3 17 lexical:fts\n`)
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
