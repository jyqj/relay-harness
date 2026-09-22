/** Real tool registration, model dispatch, workspace retrieval and durable result propagation. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@relay-harness/cordis'
import AgentRegistry from '@relay-harness/rlh-agent'
import AgentLoop from '@relay-harness/rlh-agent-loop'
import ContextEngine, { EvidenceId, SourceId } from '@relay-harness/rlh-context-engine'
import CodeContext from '@relay-harness/rlh-code-context'
import CodeIndexLocal from '@relay-harness/rlh-code-index-local'
import FileSystemLocal from '@relay-harness/rlh-fs-local'
import LlmRuntime, { CallId, LlmAdapter, createUserMessage } from '@relay-harness/rlh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@relay-harness/rlh-llm'
import SessionStore, { SessionId } from '@relay-harness/rlh-session'
import SystemPrompt from '@relay-harness/rlh-system-prompt'
import ToolRuntime from '@relay-harness/rlh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as tool from '../src/index.ts'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

class RetrievalAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async * stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    if (this.requests.length === 1) {
      const args = JSON.stringify({ query: 'spoolQuantaMarker', sources: ['code-index-recall'] })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: CallId('retrieve-1'), name: 'retrieve_context', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId('retrieve-1'), name: 'retrieve_context', arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'Located the workspace source.' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Located the workspace source.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

async function harness(config: tool.Config = {}) {
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ContextEngine)
  await ctx.plugin(AgentLoop, { agents: [] })
  const fiber = ctx.plugin(tool, config)
  await fiber
  const agent = ctx.agentLoop.create(SessionId('retrieval-owner'), {}, { cwd: '/owned' })
  const execute = (args: Record<string, unknown>, signal = new AbortController().signal) => ctx.tools.execute({
    callId: CallId('test-call'), name: 'retrieve_context', arguments: args, agent, signal,
  })
  return { ctx, agent, fiber, execute }
}

function evidence(text = 'located') {
  return {
    message: createUserMessage({ source: { kind: 'plugin' as const, plugin: 'test-source' }, content: [{ type: 'text' as const, text }] }),
    evidence: [{ evidenceId: EvidenceId('e1'), resource: { sourceId: SourceId('owned'), key: 'file', revision: 'r1' },
      truncated: false, freshness: 'current' as const, verification: 'unverified' as const }],
    coverage: { searched: ['owned'], notSearched: [], completeness: 'bounded' as const },
  }
}

describe('retrieve_context', () => {
  it('lists only tool-enabled sources without reading them and releases registration on unload', async () => {
    const { ctx, agent, execute, fiber } = await harness()
    const contribute = vi.fn(async () => evidence())
    ctx.contextEngine.registerContributor({ id: 'automatic', contribute })
    ctx.contextEngine.registerContributor({ id: 'active', purposes: ['tool_retrieval'], contribute })
    const result = await execute({})
    expect(result.isError).toBe(false)
    if (!result.isError) expect(result.value).toMatchObject({ status: 'catalog', sources: [{ id: 'active' }], observations: [] })
    expect(contribute).not.toHaveBeenCalled()
    expect(ctx.tools.schemas(agent).some(item => item.name === 'retrieve_context')).toBe(true)
    await fiber.dispose()
    expect(ctx.tools.schemas(agent).some(item => item.name === 'retrieve_context')).toBe(false)
  })

  it('takes caller identity from the exact live Agent, never arguments or a synthetic user message', async () => {
    const { ctx, agent, execute } = await harness()
    const contribute = vi.fn(async () => evidence())
    ctx.contextEngine.registerContributor({ id: 'active', purposes: ['tool_retrieval'], contribute })
    const result = await execute({ query: ' find ', sessionId: 'foreign', cwd: '/foreign', userId: 'admin' })
    expect(result.isError).toBe(false)
    expect(contribute).toHaveBeenCalledWith(expect.objectContaining({
      purpose: 'tool_retrieval', query: 'find', messages: [], cwd: '/owned',
      caller: expect.objectContaining({ sessionId: agent.id, agentId: agent.id, workspaceId: '/owned' }) as unknown,
    }))
    expect(agent.session.events.filter(event => event.type === 'user/message')).toEqual([])
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('not instructions or permission grants') as unknown })
  })

  it('refuses unavailable source ids, blank/oversized queries, and calls without a current owner', async () => {
    const { ctx, execute } = await harness({ maxQueryChars: 4 })
    for (const args of [{ query: '' }, { query: 'large' }, { query: 'find', sources: ['foreign'] }]) {
      expect((await execute(args)).isError).toBe(true)
    }
    expect((await ctx.tools.execute({ callId: CallId('none'), name: 'retrieve_context', arguments: {}, signal: new AbortController().signal })).isError).toBe(true)
  })

  it('constrains source selection to the deployment allowlist and reports missing configuration', async () => {
    const { ctx, execute } = await harness({ contributors: ['permitted'] })
    expect((await execute({})).isError).toBe(true)
    const denied = vi.fn(async () => evidence('denied'))
    ctx.contextEngine.registerContributor({ id: 'denied', purposes: ['tool_retrieval'], contribute: denied })
    ctx.contextEngine.registerContributor({ id: 'permitted', purposes: ['tool_retrieval'], contribute: async () => evidence('yes') })
    const result = await execute({ query: 'find' })
    expect(result.isError).toBe(false)
    expect(denied).not.toHaveBeenCalled()
    expect((await execute({ query: 'find', sources: ['denied'] })).isError).toBe(true)
  })

  it('honors cancellation and does not publish a late successful observation', async () => {
    const { ctx, execute } = await harness()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<ReturnType<typeof evidence>>()
    ctx.contextEngine.registerContributor({ id: 'active', purposes: ['tool_retrieval'], contribute: async () => { entered.resolve(undefined); return release.promise } })
    const controller = new AbortController()
    const pending = execute({ query: 'find' }, controller.signal)
    await entered.promise
    controller.abort(new Error('stopped'))
    const result = await pending
    expect(result.isError).toBe(true)
    release.resolve(evidence())
  })

  it('refuses host-local index reads across an isolated filesystem even when cwd is identical', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rlh-tool-context-world-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    await writeFile(join(root, 'marker.ts'), 'export const spoolQuantaMarker = 42\n')
    const { ctx } = await harness()
    await ctx.plugin(FileSystemLocal)
    await ctx.plugin(CodeIndexLocal, { workspaceRoot: root, databasePath: ':memory:' })
    await ctx.plugin(CodeContext, { minQueryChars: 8 })
    const agent = ctx.agentLoop.create(SessionId('isolated-world'), {}, { cwd: root })
    // A deployment's isolated execution realm uses the same public Cordis context operation.
    Object.defineProperty(agent, 'ctx', { value: agent.ctx.isolate('fs') })
    const result = await ctx.tools.execute({
      callId: CallId('world-check'), name: 'retrieve_context', agent,
      arguments: { query: 'spoolQuantaMarker', sources: ['code-index-recall'] }, signal: new AbortController().signal,
    })
    expect(result.isError).toBe(false)
    if (!result.isError) expect(result.value).toMatchObject({ observations: [], decisions: [
      { source: 'code-index-recall', outcome: 'rejected', reasons: ['degraded', 'hydration_unavailable'] },
    ] })
    expect(JSON.stringify(result)).not.toContain('export const spoolQuantaMarker')
  })

  it('executes the advertised tool against a real local index and logs its output exactly once for the next model request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rlh-tool-context-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    await writeFile(join(root, 'marker.ts'), 'export const spoolQuantaMarker = 42\n')
    const { ctx } = await harness()
    await ctx.plugin(FileSystemLocal)
    await ctx.plugin(CodeIndexLocal, { workspaceRoot: root, databasePath: ':memory:' })
    await ctx.plugin(CodeContext, { minQueryChars: 8 })
    const adapter = new RetrievalAdapter()
    ctx.llm.registerAdapter(['scripted'], adapter)
    const agent = ctx.agentLoop.create(SessionId('real-retrieval'), { provider: 'scripted', model: 'fixture' }, { cwd: root })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'go' }] }))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[0]?.tools?.some(item => item.name === 'retrieve_context')).toBe(true)
    const results = agent.session.events.filter(event => event.type === 'tool/result')
    expect(results).toHaveLength(1)
    const rendered = JSON.stringify(results[0])
    expect(rendered).toContain('spoolQuantaMarker')
    expect(rendered).toContain('marker.ts')
    expect(rendered).toContain('current')
    expect(agent.session.events.filter(event => event.type === 'tool/call')).toHaveLength(1)
    expect(agent.session.events.filter(event => event.type === 'user/message')).toHaveLength(1)
    const nextMessages = JSON.stringify(adapter.requests[1]?.messages)
    expect(nextMessages).toContain('spoolQuantaMarker')
    expect(nextMessages).toContain('retrieve-1')
    expect(agent.session.events.filter(event => event.type === 'context/prepared')).toHaveLength(0)
  })
})
