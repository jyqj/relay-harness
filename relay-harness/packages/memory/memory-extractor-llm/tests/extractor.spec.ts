import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, {
  LlmAdapter,
  createUserMessage,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { MEMORY_EXTRACTION_PROMPT_VERSION } from '../src/prompt.ts'
import { collectExtractionSources } from '../src/sources.ts'
import * as Extractor from '@deepseek-ai/dsh-memory-extractor-llm'
import * as MemoryAgent from '@deepseek-ai/dsh-memory-agent'
import SqliteLongTermMemory from '@deepseek-ai/dsh-memory-sqlite'
import type {
  EnqueueMemoryExtractionInput,
  MemoryEntry,
  MemoryExtractionJob,
  RememberMemoryInput,
} from '@deepseek-ai/dsh-memory/types'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'

type ScriptEntry = string | { kind: 'hang' } | { kind: 'error'; message: string }

class ScriptAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: ScriptEntry[]) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async* stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('extractor test adapter script exhausted')
    if (typeof entry === 'object' && entry.kind === 'hang') {
      await new Promise<void>((_resolve, reject) => {
        if (options.signal?.aborted === true) { reject(new Error('aborted')); return }
        options.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      })
      return
    }
    if (typeof entry === 'object') throw new Error(entry.message)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: entry }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: entry } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 10 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class FailingMemory extends SqliteLongTermMemory {
  override remember(_input: RememberMemoryInput): Promise<MemoryEntry> {
    return Promise.reject(new Error('memory provider offline'))
  }
}

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-memory-extractor-'))
  temporaryDirectories.push(directory)
  return join(directory, 'memory.db')
}

function candidate(content: string, quote: string, kind = 'fact'): string {
  return JSON.stringify({ candidates: [{ kind, content, importance: 3, evidence_quote: quote }] })
}

function input(overrides: Partial<EnqueueMemoryExtractionInput> = {}): EnqueueMemoryExtractionInput {
  return {
    promptVersion: MEMORY_EXTRACTION_PROMPT_VERSION,
    scope: { workspaceId: 'global', userId: 'local', agentId: 'deepseek-harness' },
    sessionId: SessionId('source-session'),
    turn: 1,
    sourceHash: 'a'.repeat(64),
    route: { provider: 'extract', model: 'extract' },
    sources: [{
      kind: 'user',
      text: 'Remember that the codename is cobalt.',
      evidence: {
        sessionId: SessionId('source-session'),
        eventSeqs: [2],
        verification: 'user-statement',
        excerpt: 'Remember that the codename is cobalt.',
      },
    }],
    maxAttempts: 3,
    ...overrides,
  }
}

const extractorConfig = {
  enabled: true,
  pollMs: 2,
  leaseMs: 10_000,
  retryDelayMs: 0,
  timeoutMs: 5_000,
  maxAttempts: 3,
} satisfies Extractor.Config

async function workerContext(
  path: string,
  adapter: ScriptAdapter,
  config: Extractor.Config = extractorConfig,
  Provider: typeof SqliteLongTermMemory = SqliteLongTermMemory,
): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(Provider, { path })
  ctx.llm.registerAdapter(['extract'], adapter)
  await ctx.plugin(Extractor, config)
  return ctx
}

async function waitForJob(
  ctx: Context,
  id: MemoryExtractionJob['id'],
  status: MemoryExtractionJob['status'],
  timeout = 2_000,
): Promise<MemoryExtractionJob> {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const job = await ctx.memoryExtractionQueue.read(id)
    if (job?.status === status) return job
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`job ${id} did not reach ${status}`)
}

describe('durable LLM memory extractor', () => {
  it('captures a completed standard turn and activates an exact user-grounded candidate', async () => {
    const path = await databasePath()
    const adapter = new ScriptAdapter([candidate('The project codename is cobalt.', 'codename is cobalt')])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SqliteLongTermMemory, { path })
    ctx.llm.registerAdapter(['extract'], adapter)
    await ctx.plugin(Extractor, { ...extractorConfig, provider: 'extract', model: 'extract', agentPresets: ['standard'] })
    const session = ctx.sessions.create(SessionId('captured'), {
      meta: { cwd: '/workspace', agentPreset: 'standard' },
    })
    session.append('request/header', { header: { config: { provider: 'conversation', model: 'conversation' } }, reason: 'initial' })
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      source: { kind: 'user' }, content: [{ type: 'text', text: 'Remember that the codename is cobalt.' }],
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const collected = collectExtractionSources(session, 1, {
      provider: 'extract',
      model: 'extract',
      verifiedToolNames: new Set(['bash', 'pwsh', 'read', 'write', 'edit', 'str_replace_editor', 'glob', 'grep']),
      maxSourceChars: 4_000,
      maxInputChars: 16_000,
    })
    if (collected === undefined) throw new Error('expected extraction sources')
    const expected = await ctx.memoryExtractionQueue.enqueue({
      ...input(),
      scope: { workspaceId: '/workspace', userId: 'local', agentId: 'deepseek-harness' },
      sessionId: session.id,
      sourceHash: collected.sourceHash,
      route: collected.route,
      sources: collected.sources,
    })
    const completed = await waitForJob(ctx, expected.id, 'completed')
    expect(completed).toMatchObject({ attempts: 1, result: { candidateCount: 1, skippedCount: 0 } })
    expect(adapter.requests[0]).toMatchObject({ purpose: 'memory-extraction', provider: 'extract', model: 'extract' })
    const memories = await ctx.longTermMemory.search({
      scope: expected.scope, query: 'codename cobalt', limit: 10,
    })
    expect(memories).toHaveLength(1)
    expect(memories[0]?.entry).toMatchObject({
      status: 'active',
      trust: 'user-stated',
      content: 'codename is cobalt',
    })
    await ctx.fiber.dispose()
  })

  it('retries invalid output and keeps forged or external evidence as candidates', async () => {
    const path = await databasePath()
    const adapter = new ScriptAdapter([
      'not-json',
      JSON.stringify({ candidates: [
        { kind: 'fact', content: 'Forged active claim.', importance: 2, evidence_quote: 'not in source' },
        { kind: 'fact', content: 'An external release note exists.', importance: 2, evidence_quote: 'external release note' },
      ] }),
    ])
    const ctx = await workerContext(path, adapter)
    const job = await ctx.memoryExtractionQueue.enqueue(input({
      sources: [{
        kind: 'tool-result',
        toolName: 'web_search',
        text: 'external release note',
        evidence: {
          sessionId: SessionId('source-session'),
          eventSeqs: [4, 5],
          verification: 'external-observation',
          excerpt: 'external release note',
        },
      }],
    }))
    const completed = await waitForJob(ctx, job.id, 'completed')
    expect(completed.attempts).toBe(2)
    expect(adapter.requests).toHaveLength(2)
    const candidates = await ctx.longTermMemory.search({
      scope: job.scope,
      query: 'claim release note',
      limit: 10,
      statuses: ['candidate'],
    })
    expect(candidates.map(hit => hit.entry.trust).sort()).toEqual(['agent-proposed', 'external'])
    expect(await ctx.longTermMemory.search({ scope: job.scope, query: 'claim release note', limit: 10 })).toEqual([])
    await ctx.fiber.dispose()
  })

  it('activates only the exact excerpt of an allowlisted successful tool result', async () => {
    const path = await databasePath()
    const adapter = new ScriptAdapter([candidate(
      'All deployment checks passed and the release is safe.',
      'deployment checks passed',
      'lesson',
    )])
    const ctx = await workerContext(path, adapter)
    const job = await ctx.memoryExtractionQueue.enqueue(input({
      sourceHash: 'f'.repeat(64),
      sources: [{
        kind: 'tool-result',
        toolName: 'bash',
        text: 'deployment checks passed',
        evidence: {
          sessionId: SessionId('source-session'),
          eventSeqs: [7, 8],
          verification: 'successful-tool-result',
          excerpt: 'deployment checks passed',
        },
      }],
    }))
    await waitForJob(ctx, job.id, 'completed')
    const memories = await ctx.longTermMemory.search({
      scope: job.scope, query: 'deployment checks', limit: 10,
    })
    expect(memories[0]?.entry).toMatchObject({
      kind: 'lesson',
      status: 'active',
      trust: 'action-verified',
      content: 'deployment checks passed',
    })
    await ctx.fiber.dispose()
  })

  it('recovers a running job after disposal, lease expiry, and process restart', async () => {
    const path = await databasePath()
    const first = await workerContext(
      path,
      new ScriptAdapter([{ kind: 'hang' }]),
      { ...extractorConfig, leaseMs: 100, timeoutMs: 50 },
    )
    const job = await first.memoryExtractionQueue.enqueue(input())
    await waitForJob(first, job.id, 'running')
    await first.fiber.dispose()

    await new Promise(resolve => setTimeout(resolve, 105))
    const second = await workerContext(
      path,
      new ScriptAdapter([candidate('The project codename is cobalt.', 'codename is cobalt')]),
      { ...extractorConfig, leaseMs: 100, timeoutMs: 50 },
    )
    const completed = await waitForJob(second, job.id, 'completed')
    expect(completed.attempts).toBe(2)
    await second.fiber.dispose()
  })

  it('completes an offline-enqueued job after restart and recalls it in a fresh Agent session', async () => {
    const path = await databasePath()
    const enqueueCtx = new Context()
    await enqueueCtx.plugin(SqliteLongTermMemory, { path })
    const job = await enqueueCtx.memoryExtractionQueue.enqueue(input({
      sessionId: SessionId('offline-source'),
      sourceHash: 'e'.repeat(64),
    }))
    await enqueueCtx.fiber.dispose()

    const extraction = await workerContext(
      path,
      new ScriptAdapter([candidate('The project codename is cobalt.', 'codename is cobalt')]),
    )
    await waitForJob(extraction, job.id, 'completed')
    await extraction.fiber.dispose()

    const conversationAdapter = new ScriptAdapter(['The codename is cobalt.'])
    const recallCtx = new Context()
    await recallCtx.plugin(LlmRuntime)
    await recallCtx.plugin(SessionStore)
    await recallCtx.plugin(SystemPrompt)
    await recallCtx.plugin(ToolRuntime)
    await recallCtx.plugin(AgentRegistry)
    await recallCtx.plugin(AgentLoop, { agents: [] })
    await recallCtx.plugin(SqliteLongTermMemory, { path })
    await recallCtx.plugin(MemoryAgent)
    recallCtx.llm.registerAdapter(['conversation'], conversationAdapter)
    const agent = recallCtx.agentLoop.create(SessionId('fresh-recall-session'), {
      provider: 'conversation', model: 'conversation',
    })
    agent.followup(createUserMessage({
      source: { kind: 'user' }, content: [{ type: 'text', text: 'What is the project codename?' }],
    }))
    await agent.whenIdle()

    expect(conversationAdapter.requests[0]?.messages.map(message => message.source.kind))
      .toEqual(['user', 'memory-recall'])
    expect(agent.session.events.some(event =>
      event.type === 'user/message' && event.data.source.kind === 'memory-recall')).toBe(true)
    await recallCtx.fiber.dispose()
  })

  it('leaves jobs pending while package-default extraction is disabled', async () => {
    const path = await databasePath()
    const adapter = new ScriptAdapter([candidate('unused', 'codename')])
    const ctx = await workerContext(path, adapter, {})
    const job = await ctx.memoryExtractionQueue.enqueue(input())
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(await ctx.memoryExtractionQueue.read(job.id)).toMatchObject({ status: 'pending', attempts: 0 })
    expect(adapter.requests).toEqual([])
    await ctx.fiber.dispose()
  })

  it('retries provider faults and records terminal failure at maxAttempts', async () => {
    const path = await databasePath()
    const adapter = new ScriptAdapter([
      candidate('The project codename is cobalt.', 'codename is cobalt'),
      candidate('The project codename is cobalt.', 'codename is cobalt'),
    ])
    const ctx = await workerContext(path, adapter, { ...extractorConfig, maxAttempts: 2 }, FailingMemory)
    const job = await ctx.memoryExtractionQueue.enqueue(input({ maxAttempts: 2 }))
    const failed = await waitForJob(ctx, job.id, 'failed')
    expect(failed).toMatchObject({ attempts: 2, lastError: 'memory provider offline' })
    await ctx.fiber.dispose()
  })
})
