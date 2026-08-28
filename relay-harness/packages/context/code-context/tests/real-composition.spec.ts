/**
 * Real-composition acceptance: the context engine, a scripted code-index
 * provider, and this plugin boot together from a test-only cordis.yml through
 * the actual Loader + Include path. With the explicit config section the
 * recall message enters the model request and the session log with its source
 * attribution intact; without the section the deployment stays byte-identical.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@relay-harness/cordis'
import Loader from '@relay-harness/cordis-plugin-loader'
import Include from '@relay-harness/cordis-plugin-include'
import AgentRegistry from '@relay-harness/rlh-agent'
import AgentLoop from '@relay-harness/rlh-agent-loop'
import ContextEngine from '@relay-harness/rlh-context-engine'
import LlmRuntime, { createUserMessage } from '@relay-harness/rlh-llm'
import type { UserMessage } from '@relay-harness/rlh-llm'
import { extractSessionEventText } from '@relay-harness/rlh-session-query/src/extraction.ts'
import SessionStore, { SessionId } from '@relay-harness/rlh-session'
import SystemPromptService from '@relay-harness/rlh-system-prompt'
import ToolRuntime from '@relay-harness/rlh-tools'
import CodeContext from '../src/index.ts'
import { MockAdapter } from './mock-llm.ts'
import StubCodeIndex, { resetStub, scripted, searchHit, searchRequests, searchResult } from './stub-code-index.ts'

const QUERY = 'where is spoolQuantaMarker defined'

const roots: string[] = []
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'rlh-code-context-'))
  roots.push(root)
  return root
}

async function loadComposition(workspaceRoot: string, enabled: boolean): Promise<void> {
  const configPath = join(workspaceRoot, 'cordis.yml')
  const entries = [
    '- id: system-prompt',
    "  name: '@relay-harness/rlh-system-prompt'",
    '- id: sessions',
    "  name: '@relay-harness/rlh-session'",
    '- id: llm',
    "  name: '@relay-harness/rlh-llm'",
    '- id: tools',
    "  name: '@relay-harness/rlh-tools'",
    '- id: agents',
    "  name: '@relay-harness/rlh-agent'",
    '- id: agent-loop',
    "  name: '@relay-harness/rlh-agent-loop'",
    '  config:',
    '    agents: []',
    '- id: context-engine',
    "  name: '@relay-harness/rlh-context-engine'",
    '- id: index-local',
    "  name: '@relay-harness/rlh-code-index-local'",
  ]
  if (enabled) {
    entries.push(
      '- id: code-context',
      "  name: '@relay-harness/rlh-code-context'",
      '  config: {}',
    )
  }
  await writeFile(configPath, `${entries.join('\n')}\n`)

  const modules = new Map<string, unknown>([
    ['@relay-harness/rlh-system-prompt', SystemPromptService],
    ['@relay-harness/rlh-session', SessionStore],
    ['@relay-harness/rlh-llm', LlmRuntime],
    ['@relay-harness/rlh-tools', ToolRuntime],
    ['@relay-harness/rlh-agent', AgentRegistry],
    ['@relay-harness/rlh-agent-loop', AgentLoop],
    ['@relay-harness/rlh-context-engine', ContextEngine],
    // The scripted stand-in for the SQLite-backed provider.
    ['@relay-harness/rlh-code-index-local', StubCodeIndex],
    ['@relay-harness/rlh-code-context', CodeContext],
  ])

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(workspaceRoot).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()
}

function directUserMessage(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function waitForIdle(ctx: Context): Promise<void> {
  return new Promise((resolve, reject) => {
    const dispose = ctx.on('agent/status', ({ status }) => {
      if (status !== 'idle') return
      dispose()
      resolve()
    })
    setTimeout(() => {
      reject(new Error('agent never went idle'))
    }, 5_000).unref()
  })
}

describe('code-context real composition', () => {
  it('boots engine, provider, and enabled plugin; the recall enters request and log', async () => {
    const root = await workspace()
    resetStub()
    scripted.search = searchResult([
      searchHit({ rank: 1, chunkId: 'chunk:src/engine.ts:1', filePath: 'src/engine.ts', endLine: 3 }),
      searchHit({ rank: 2, chunkId: 'chunk:src/pump.ts:1', filePath: 'src/pump.ts', score: 17 }),
    ])
    await loadComposition(root, true)

    expect(context?.get('codeContext')).toBeDefined()
    expect(context?.get('contextEngine')).toBeDefined()
    expect(context?.get('codeIndex')).toBeDefined()

    // Direct seam: prepareStep carries the recall message and its evidence.
    const prepared = await context!.get('contextEngine')!.prepareStep({
      messages: [directUserMessage(QUERY)],
      signal: new AbortController().signal,
      cwd: root,
    })
    expect(prepared?.messages).toHaveLength(1)
    expect(prepared?.messages[0]?.source).toMatchObject({
      kind: 'code-index',
      form: 'recall',
      query: QUERY,
      hits: [{ filePath: 'src/engine.ts' }, { filePath: 'src/pump.ts' }],
    })
    expect(prepared?.evidence).toHaveLength(2)
    expect(prepared?.evidence[0]).toMatchObject({
      resource: { sourceId: 'code-index', key: 'chunk:src/engine.ts:1', revision: '7' },
      truncated: false,
    })

    // Loop path: the recall message appends to the request after the direct text.
    const adapter = new MockAdapter(['ok'])
    context!.llm.registerAdapter(['mock'], adapter)
    const agent = context!.agentLoop.create(SessionId('real-recall'), { provider: 'mock', model: 'mock' })
    agent.followup(directUserMessage(QUERY))
    await waitForIdle(context!)

    const requestMessages = adapter.requests[0]?.messages ?? []
    expect(requestMessages.map(message => message.source.kind)).toEqual(['user', 'code-index'])
    const recall = requestMessages[1]
    expect(recall?.source).toMatchObject({ form: 'recall', query: QUERY })
    expect(recall?.content.map(block => (block.type === 'text' ? block.text : '')).join(''))
      .toContain('src/engine.ts:1-3 42 lexical:fts')

    // Model-visible ⟺ logged: both messages are reconstructable from the log.
    const logged = [...agent.session.events].filter(event => event.type === 'user/message')
    expect(logged).toHaveLength(2)
    expect(extractSessionEventText(logged[0]!)).toBe(QUERY)
    expect(extractSessionEventText(logged[1]!)).toBe('')
    expect(logged[1]!.data.source).toMatchObject({ kind: 'code-index', form: 'recall', query: QUERY })
  })

  it('keeps the deployment byte-identical without the config section', async () => {
    const root = await workspace()
    resetStub()
    scripted.search = searchResult([searchHit()])
    await loadComposition(root, false)

    expect(context?.get('codeContext')).toBeUndefined()
    expect(context?.get('contextEngine')).toBeDefined()

    const prepared = await context!.get('contextEngine')!.prepareStep({
      messages: [directUserMessage(QUERY)],
      signal: new AbortController().signal,
      cwd: root,
    })
    expect(prepared).toBeUndefined()

    const adapter = new MockAdapter(['ok'])
    context!.llm.registerAdapter(['mock'], adapter)
    const agent = context!.agentLoop.create(SessionId('real-silent'), { provider: 'mock', model: 'mock' })
    agent.followup(directUserMessage(QUERY))
    await waitForIdle(context!)
    expect(adapter.requests[0]?.messages.map(message => message.source.kind)).toEqual(['user'])
    expect(searchRequests).toEqual([])
  })
})
