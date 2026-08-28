import { describe, expect, it } from 'vitest'
import { Context, Service } from '@relay-harness/cordis'
import LlmRuntime, { createUserMessage } from '@relay-harness/rlh-llm'
import SessionStore, { SessionId, type UserMessage } from '@relay-harness/rlh-session'
import SystemPrompt from '@relay-harness/rlh-system-prompt'
import ToolRuntime from '@relay-harness/rlh-tools'
import AgentRegistry, { type Agent } from '@relay-harness/rlh-agent'

import AgentLoop from '@relay-harness/rlh-agent-loop'
import { MockAdapter, textResponse } from './mock-adapter.ts'

/**
 * The optional step-context seam: a service registered under `contextEngine` runs between
 * inbox claim and prompt assembly, and its messages append to the step's user messages.
 * Without the service, the loop's behavior is byte-identical. The loop consumes the
 * engine through a structural interface only — these tests register a scripted service,
 * not `@relay-harness/rlh-context-engine` itself.
 */

interface StepCall {
  messages: readonly UserMessage[]
  signal: AbortSignal
}

/** A scripted `contextEngine` service: records calls, returns the scripted messages. */
class ScriptedEngine extends Service {
  readonly calls: StepCall[] = []

  constructor(ctx: Context, private readonly result: { messages: UserMessage[] } | undefined) {
    super(ctx, 'contextEngine')
  }

  prepareStep(input: { messages: readonly UserMessage[]; signal: AbortSignal; cwd: string }):
  Promise<{ messages: readonly UserMessage[] } | undefined> {
    this.calls.push(input)
    return Promise.resolve(this.result)
  }
}

async function harness(adapter: MockAdapter) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

function send(agent: Agent, text: string) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

function requestTexts(adapter: MockAdapter): string[][] {
  return adapter.requests.map(request =>
    request.messages.map(message =>
      message.content.map(block => (block.type === 'text' ? block.text : '')).join(''),
    ),
  )
}

describe('step-context seam', () => {
  it('appends engine messages after the claimed message and logs them as user/message events', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const engine = new ScriptedEngine(ctx, {
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'context from engine' }],
        source: { kind: 'user' },
      })],
    })
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    send(agent, 'hello')
    await waitForIdle(ctx, agent)

    expect(engine.calls.length).toBe(1)
    expect(engine.calls[0]!.messages.map(message =>
      message.content.map(block => (block.type === 'text' ? block.text : '')).join(''),
    )).toEqual(['hello'])
    expect(requestTexts(adapter)).toEqual([['hello', 'context from engine']])
    const logged = [...agent.session.events]
      .filter(event => event.type === 'user/message')
      .map(event => event.type === 'user/message'
        ? event.data.content.map(block => (block.type === 'text' ? block.text : '')).join('')
        : '')
    expect(logged).toEqual(['hello', 'context from engine'])
  })

  it('leaves the request unchanged when the engine declines or is absent', async () => {
    const declining = new MockAdapter([textResponse('ok')])
    const decliningCtx = await harness(declining)
    const decliningEngine = new ScriptedEngine(decliningCtx, undefined)
    const decliningAgent = decliningCtx.agentLoop.create(SessionId('d1'), { provider: 'mock', model: 'mock' })
    send(decliningAgent, 'hello')
    await waitForIdle(decliningCtx, decliningAgent)
    expect(decliningEngine.calls.length).toBe(1)
    expect(requestTexts(declining)).toEqual([['hello']])

    const absent = new MockAdapter([textResponse('ok')])
    const absentCtx = await harness(absent)
    const absentAgent = absentCtx.agentLoop.create(SessionId('a2'), { provider: 'mock', model: 'mock' })
    send(absentAgent, 'hello')
    await waitForIdle(absentCtx, absentAgent)
    expect(requestTexts(absent)).toEqual([['hello']])
  })
})
