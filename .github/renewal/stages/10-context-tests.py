"""Executable regressions for the native context retrieval path."""
write('packages/context/context-engine/tests/native-retrieval.spec.ts', r'''import { describe, expect, it } from 'vitest'
import { Context } from '@relay-harness/cordis'
import { createUserMessage } from '@relay-harness/rlh-llm'
import { SessionId } from '@relay-harness/rlh-session'
import ContextEngine from '../src/index.ts'
import type { ContextPrepareInput, ContributedStepContext } from '../src/index.ts'

function input(overrides: Partial<ContextPrepareInput> = {}): ContextPrepareInput {
  return { purpose: 'agent_tool', query: 'where is the parser', messages: [], cwd: '/workspace',
    signal: new AbortController().signal,
    caller: { sessionId: SessionId('retrieval-test'), agentId: 'retrieval-test', workspaceId: '/workspace' },
    ...overrides }
}
function candidate(text: string): ContributedStepContext {
  return { message: createUserMessage({ source: { kind: 'plugin', plugin: 'test-source' }, content: [{ type: 'text', text }] }) }
}

describe('native retrieval planning', () => {
  it('keeps model queries separate and excludes providers that did not opt in', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(ContextEngine)
      const seen: string[] = []
      ctx.contextEngine.registerContributor({ id: 'legacy', contribute: async () => { throw new Error('legacy must not receive model queries') } })
      ctx.contextEngine.registerContributor({ id: 'code', purposes: ['agent_tool'], contribute: async request => {
        expect(request.messages).toEqual([])
        seen.push(request.query ?? '')
        return candidate('code evidence')
      } })
      const result = await ctx.contextEngine.prepareStep(input())
      expect(seen).toEqual(['where is the parser'])
      expect(result?.plan.contributors.find(item => item.contributorId === 'legacy')?.eligible).toBe(false)
      expect(result?.contributions.map(item => item.contributorId)).toEqual(['code'])
    } finally { await ctx.fiber.dispose() }
  })

  it('charges separate candidates against one aggregate provider budget', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(ContextEngine, { maxChars: 100, maxContributorChars: 10 })
      ctx.contextEngine.registerContributor({ id: 'many', purposes: ['agent_tool'],
        contribute: async () => { throw new Error('atomic fallback must not run') },
        contributeCandidates: async () => [candidate('123456'), candidate('abcdef')] })
      const result = await ctx.contextEngine.prepareStep(input())
      expect(result?.contributions).toHaveLength(1)
      expect(result?.decisions.map(item => item.outcome)).toEqual(['selected', 'rejected'])
      expect(result?.decisions[1]?.reasons).toContain('contributor_char_budget')
    } finally { await ctx.fiber.dispose() }
  })

  it('uses stable provider identity order for explicit retrieval', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(ContextEngine)
      for (const id of ['z', 'a']) ctx.contextEngine.registerContributor({ id, purposes: ['agent_tool'], contribute: async () => candidate(id) })
      const result = await ctx.contextEngine.prepareStep(input())
      expect(result?.contributions.map(item => item.contributorId)).toEqual(['a', 'z'])
      const selected = await ctx.contextEngine.prepareStep(input({ contributorIds: ['z'] }))
      expect(selected?.contributions.map(item => item.contributorId)).toEqual(['z'])
      expect(selected?.plan.contributors.find(item => item.contributorId === 'a')?.reason).toBe('provider_not_requested')
    } finally { await ctx.fiber.dispose() }
  })

  it('clamps request limits to deployment limits and rejects invalid requests', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(ContextEngine, { maxChars: 20, maxTokens: 100 })
      ctx.contextEngine.registerContributor({ id: 'budget', purposes: ['agent_tool'], contribute: async request => {
        expect(request.budget.maxChars).toBe(20)
        return candidate('twenty or less')
      } })
      expect((await ctx.contextEngine.prepareStep(input({ limits: { maxChars: 10000 } })))?.plan.budget.maxChars).toBe(20)
      for (const maxChars of [0, -1, 1.5, Number.NaN, Infinity]) {
        await expect(ctx.contextEngine.prepareStep(input({ limits: { maxChars } }))).rejects.toThrow('positive safe integers')
      }
    } finally { await ctx.fiber.dispose() }
  })
})
''')
write('packages/context/tool-context/tests/retrieval.spec.ts', r'''import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Context } from '@relay-harness/cordis'
import Loader from '@relay-harness/cordis-plugin-loader'
import Include from '@relay-harness/cordis-plugin-include'
import AgentRegistry from '@relay-harness/rlh-agent'
import AgentLoop from '@relay-harness/rlh-agent-loop'
import ContextEngine from '@relay-harness/rlh-context-engine'
import type { PreparedStepContext } from '@relay-harness/rlh-context-engine'
import LlmRuntime, { CallId, LlmAdapter, createUserMessage } from '@relay-harness/rlh-llm'
import type { GenerateOptions, StreamChunk } from '@relay-harness/rlh-llm'
import SessionStore, { SessionId } from '@relay-harness/rlh-session'
import SystemPrompt from '@relay-harness/rlh-system-prompt'
import ToolRuntime from '@relay-harness/rlh-tools'
import * as ToolContext from '../src/index.ts'

class RetrievalModel extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override resolveModel(provider: string, model: string) { return Promise.resolve({ provider, id: model, name: model }) }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length === 1) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: CallId('retrieve-call'), name: 'retrieve_context', argumentsDelta: '{"query":"native query"}' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId('retrieve-call'), name: 'retrieve_context', arguments: '{"query":"native query"}' } }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Answer grounded in retrieved evidence.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Answer grounded in retrieved evidence.' } }
    yield { type: 'usage', usage: { inputTokens: 30, outputTokens: 8 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it('advertises and dispatches retrieve_context through a real YAML-composed Agent', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'rlh-tool-context-'))
  const ctx = new Context()
  try {
    const modules = new Map<string, unknown>([
      ['system-prompt', SystemPrompt], ['sessions', SessionStore], ['llm', LlmRuntime],
      ['tools', ToolRuntime], ['agents', AgentRegistry], ['agent-loop', AgentLoop],
      ['context-engine', ContextEngine], ['tool-context', ToolContext],
    ])
    const configPath = join(cwd, 'cordis.yml')
    await writeFile(configPath, [...modules.keys()].map(name => `- name: ${name}${name === 'agent-loop' ? '\n  config:\n    agents: []' : ''}`).join('\n') + '\n')
    ctx.baseUrl = pathToFileURL(cwd).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.internal = { version: 'v2', async import(specifier: string) {
      const module = modules.get(specifier)
      if (module === undefined) throw new Error(`Unknown fixture plugin ${specifier}`)
      return module
    } } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
    const model = new RetrievalModel()
    ctx.llm.registerAdapter(['mock'], model)
    const observed: Array<{ sessionId: string; query?: string; count: number; cwd: string }> = []
    ctx.contextEngine.registerContributor({ id: 'source', purposes: ['agent_tool'], contribute: async input => {
      observed.push({ sessionId: input.caller.sessionId, query: input.query, count: input.messages.length, cwd: input.cwd })
      return { message: createUserMessage({ source: { kind: 'plugin', plugin: 'source' }, content: [{ type: 'text', text: 'source-marker-84' }] }),
        coverage: { searched: ['fixture source'], notSearched: [], completeness: 'bounded' } }
    } })
    const agent = ctx.agentLoop.create(SessionId('native-retrieval'), { provider: 'mock', model: 'mock', cwd })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Investigate the source.' }] }))
    await agent.whenIdle()
    expect(model.requests).toHaveLength(2)
    expect(model.requests[0]?.tools?.some(tool => tool.name === 'retrieve_context')).toBe(true)
    expect(observed).toEqual([{ sessionId: 'native-retrieval', query: 'native query', count: 0, cwd }])
    const results = agent.session.events.filter(event => event.type === 'tool/result')
    expect(results).toHaveLength(1)
    expect(JSON.stringify(results)).toContain('source-marker-84')
    expect(JSON.stringify(model.requests[1]?.messages).match(/source-marker-84/g)).toHaveLength(1)
    const userMessages = agent.session.events.filter(event => event.type === 'user/message')
    expect(JSON.stringify(userMessages)).not.toContain('source-marker-84')
    expect(JSON.stringify(userMessages)).not.toContain('native query')
    expect(agent.session.events.filter(event => event.type === 'context/prepared')).toHaveLength(0)
  } finally {
    await ctx.fiber.dispose()
    await rm(cwd, { recursive: true, force: true })
  }
})

describe('complete retrieval result budget', () => {
  it('includes metadata within the ceiling and removes evidence with omitted content', () => {
    const message = createUserMessage({ source: { kind: 'plugin', plugin: 'fixture' }, content: [{ type: 'text', text: 'x'.repeat(10000) }] })
    const prepared: PreparedStepContext = {
      plan: { purpose: 'agent_tool', budget: { maxChars: 10000, maxTokens: 3000 }, contributors: [] },
      decisions: [], messages: [message], evidence: [], coverage: [],
      contributions: [{ contributorId: 'source', message, evidence: [] }],
    }
    const text = ToolContext.renderRetrieval(prepared, 512)
    expect(Array.from(text).length).toBeLessThanOrEqual(512)
    expect(JSON.parse(text)).toMatchObject({ records: [], omitted: 1, coverage: 'bounded' })
  })
  it('does not claim exhaustive absence when all providers decline', () => {
    const value = JSON.parse(ToolContext.renderRetrieval(undefined, 512))
    expect(value.coverage).toBe('bounded')
    expect(value.note).toContain('do not establish absence')
    expect(value.records).toEqual([])
  })
})
''')
# Test-only dependencies preserve public service seams without making production depend on the loop.
manifest_path = ROOT / 'packages/context/tool-context/package.json'
manifest = json.loads(manifest_path.read_text())
for dependency in ['@relay-harness/cordis-plugin-loader', '@relay-harness/cordis-plugin-include', '@relay-harness/rlh-agent-loop', '@relay-harness/rlh-llm', '@relay-harness/rlh-system-prompt']:
    manifest['devDependencies'][dependency] = 'workspace:^'
manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
