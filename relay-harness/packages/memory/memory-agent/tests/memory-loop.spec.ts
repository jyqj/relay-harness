import { Context } from '@relay-harness/cordis'
import AgentRegistry, { type Agent } from '@relay-harness/rlh-agent'
import AgentLoop from '@relay-harness/rlh-agent-loop'
import ContextEngine from '@relay-harness/rlh-context-engine'
import LlmRuntime, {
  LlmAdapter,
  createUserMessage,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@relay-harness/rlh-llm'
import * as MemoryAgent from '@relay-harness/rlh-memory-agent'
import SqliteLongTermMemory from '@relay-harness/rlh-memory-sqlite'
import SessionStore, { SessionId } from '@relay-harness/rlh-session'
import SystemPrompt from '@relay-harness/rlh-system-prompt'
import ToolRuntime from '@relay-harness/rlh-tools'
import { describe, expect, it } from 'vitest'

class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async* stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Use explicit File Context.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Use explicit File Context.' } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function harness(adapter: RecordingAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ContextEngine)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SqliteLongTermMemory, { path: ':memory:' })
  await ctx.plugin(MemoryAgent)
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function send(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
}

describe('memory recall through the real Agent loop', () => {
  it('places cross-session recall in both the model request and durable session log', async () => {
    const adapter = new RecordingAdapter()
    const ctx = await harness(adapter)
    const source = SessionId('memory-source')
    const entry = await ctx.longTermMemory.remember({
      scope: { workspaceId: 'global', userId: 'local', agentId: 'relay-harness' },
      kind: 'constraint',
      content: 'Referenced files enter only through explicit File Context.',
      importance: 4,
      confidence: 1,
      trust: 'user-stated',
      status: 'active',
      evidence: [{
        sessionId: source,
        eventSeqs: [0],
        verification: 'user-statement',
        excerpt: 'explicit File Context',
      }],
    })
    const agent = ctx.agentLoop.create(SessionId('memory-target'), { provider: 'mock', model: 'mock' })

    send(agent, 'How should referenced files enter the prompt?')
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    const requestSources = adapter.requests[0]?.messages.map(message => message.source.kind)
    expect(requestSources).toEqual(['user', 'memory-recall'])
    const loggedRecall = agent.session.events.find(event =>
      event.type === 'user/message' && event.data.source.kind === 'memory-recall')
    const recallBlock = loggedRecall?.type === 'user/message' ? loggedRecall.data.content[0] : undefined
    expect(recallBlock?.type).toBe('text')
    expect(recallBlock?.type === 'text' ? recallBlock.text : '').toContain('explicit File Context')
    expect(agent.session.deriveMessages().map(message => message.source.kind))
      .toEqual(['user', 'memory-recall', 'model'])
    expect(await ctx.longTermMemory.read(
      { workspaceId: 'global', userId: 'local', agentId: 'relay-harness' },
      entry.id,
    )).toMatchObject({ accessCount: 1 })
    await ctx.fiber.dispose()
  })

  it('previews memory for Prompt Enhancement without changing access counters or turn state', async () => {
    const adapter = new RecordingAdapter()
    const ctx = await harness(adapter)
    const entry = await ctx.longTermMemory.remember({
      scope: { workspaceId: 'global', userId: 'local', agentId: 'relay-harness' },
      kind: 'preference',
      content: 'Prefer concise Chinese answers.',
      importance: 4,
      confidence: 1,
      trust: 'user-stated',
      status: 'active',
      evidence: [{
        sessionId: SessionId('memory-source'),
        eventSeqs: [0],
        verification: 'user-statement',
      }],
    })
    const agent = ctx.agentLoop.create(SessionId('prompt-target'), { provider: 'mock', model: 'mock' })
    const draft = createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'Please improve this Chinese answer request' }],
    })
    const prepared = await ctx.contextEngine.prepareStep({
      purpose: 'prompt_enhancement',
      messages: [draft],
      signal: new AbortController().signal,
      cwd: process.cwd(),
      caller: { sessionId: agent.id, agentId: agent.id, workspaceId: 'global' },
    })
    expect(prepared?.messages[0]?.source.kind).toBe('memory-recall')
    expect(prepared?.evidence[0]?.resource).toMatchObject({
      sourceId: 'long-term-memory',
      key: entry.id,
      revision: '1',
    })
    expect(await ctx.longTermMemory.read(
      { workspaceId: 'global', userId: 'local', agentId: 'relay-harness' }, entry.id,
    )).toMatchObject({ accessCount: 0, usefulAccessCount: 0 })
    expect(agent.session.events).toEqual([])
    await ctx.fiber.dispose()
  })
})
