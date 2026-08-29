import { describe, expect, it } from 'vitest'
import { Context } from '@relay-harness/cordis'
import type { Agent } from '@relay-harness/rlh-agent'
import AgentLoop from '@relay-harness/rlh-agent-loop'
import { mountAgentLoopTestDependencies } from '@relay-harness/rlh-agent-loop-testkit'
import { CallId, createUserMessage } from '@relay-harness/rlh-llm'
import { SessionId, type SessionEvent } from '@relay-harness/rlh-session'
import { defineContentToolFixture } from '@relay-harness/rlh-tools'
import * as RolloutBudget from '../src/index.ts'
import type { Config } from '../src/index.ts'
import {
  MockAdapter,
  textResponse,
  toolCallResponse,
} from '../../../core/agent-loop/tests/mock-adapter.ts'

async function harness(config: Config): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(RolloutBudget, config)
  return ctx
}

function send(agent: Agent, text = 'go'): void {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }))
}

function reminders(agent: Agent): SessionEvent<'user/message'>[] {
  return agent.session.events.filter((event): event is SessionEvent<'user/message'> =>
    event.type === 'user/message'
    && event.data.source.kind === 'plugin'
    && event.data.source.plugin === 'rollout-budget-controller')
}

function createAgent(
  ctx: Context,
  id: string,
  adapter: MockAdapter,
  parentSession?: SessionId,
): Agent {
  ctx.llm.registerAdapter([id], adapter)
  return ctx.agentLoop.create(
    SessionId(id),
    { provider: id, model: 'mock' },
    parentSession === undefined ? {} : { parentSession } as never,
  )
}

describe('shared root-session rollout accounting', () => {
  it('delivers crossed-threshold reminders independently to root and child Agents', async () => {
    const ctx = await harness({
      limitTokens: 100,
      reminderAtRemainingTokens: [50, 20],
    })
    const root = createAgent(ctx, 'root-reminder', new MockAdapter([
      textResponse('x'.repeat(40)),
      textResponse('root done'),
    ]))
    send(root)
    await root.whenIdle()

    const child = createAgent(ctx, 'child-reminder', new MockAdapter([
      textResponse('c'),
    ]), root.id)
    expect(child.session.header.parentSession).toBe(root.id)
    send(child)
    await child.whenIdle()
    expect(reminders(child)).toHaveLength(1)
    expect(reminders(child)[0]!.data.content).toEqual([{
      type: 'text',
      text: 'You have 50 weighted tokens left in the shared root-session rollout budget.',
    }])

    send(root, 'continue')
    await root.whenIdle()
    expect(reminders(root)).toHaveLength(1)
    expect(reminders(root)[0]!.data.content).toEqual([{
      type: 'text',
      text: 'You have 39 weighted tokens left in the shared root-session rollout budget.',
    }])
  })

  it('rejects a later root request after root and child usage exhaust the shared budget', async () => {
    const ctx = await harness({ limitTokens: 100, reminderAtRemainingTokens: [20] })
    const errors: unknown[] = []
    ctx.on('agent/error', ({ error }) => { errors.push(error) })
    const rootAdapter = new MockAdapter([textResponse('r'.repeat(40))])
    const root = createAgent(ctx, 'root-exhaustion', rootAdapter)
    send(root)
    await root.whenIdle()
    const child = createAgent(ctx, 'child-exhaustion', new MockAdapter([
      textResponse('c'.repeat(40)),
    ]), root.id)
    send(child)
    await child.whenIdle()

    send(root, 'one request too many')
    await root.whenIdle()
    expect(rootAdapter.requests).toHaveLength(1)
    expect(errors).toContainEqual(expect.objectContaining({
      name: 'RolloutBudgetError',
      code: 'ROLLOUT_BUDGET_EXCEEDED',
    }))
    expect(root.session.events.findLast(event => event.type === 'turn/end'))
      .toMatchObject({ data: { reason: { kind: 'error', error: { code: 'UNKNOWN' } } } })
  })

  it('does not double-charge a fork seed or a session rescanned at pre-step', async () => {
    const ctx = await harness({ limitTokens: 75, reminderAtRemainingTokens: [20] })
    const root = createAgent(ctx, 'root-seed', new MockAdapter([
      textResponse('r'.repeat(40)),
    ]))
    send(root)
    await root.whenIdle()

    const childAdapter = new MockAdapter([textResponse('ok')])
    ctx.llm.registerAdapter(['forked'], childAdapter)
    const seed = root.session.events
    const handle = await ctx.agents.create({
      sessionId: SessionId('forked-child'),
      seed,
      meta: {
        parentSession: root.id,
        seedLength: seed.length,
        origin: 'subagent',
      },
      agentOptions: { provider: 'forked', model: 'mock' },
    })
    send(handle.agent)
    await handle.agent.whenIdle()
    expect(childAdapter.requests).toHaveLength(1)
    await handle.dispose()
  })

  it('contains a missing durable ancestor as the root identity', async () => {
    const ctx = await harness({ limitTokens: 100, reminderAtRemainingTokens: [] })
    const adapter = new MockAdapter([textResponse('ok')])
    const child = createAgent(ctx, 'orphan-child', adapter, SessionId('absent-root'))
    send(child)
    await child.whenIdle()
    expect(adapter.requests).toHaveLength(1)
  })

  it('honors a downstream pre-step rejection without adding a reminder', async () => {
    const ctx = await harness({ limitTokens: 100, reminderAtRemainingTokens: [50] })
    ctx.on('agent/pre-step', (_payload, _next) => Promise.resolve({ kind: 'reject' }))
    const adapter = new MockAdapter([textResponse('unused')])
    const agent = createAgent(ctx, 'rejected-step', adapter)
    send(agent)
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(0)
    expect(reminders(agent)).toHaveLength(0)
  })

  it('derives the greatest durable reminder index and does not duplicate it', async () => {
    const ctx = await harness({ limitTokens: 100, reminderAtRemainingTokens: [50, 20] })
    const adapter = new MockAdapter([textResponse('ok')])
    const agent = createAgent(ctx, 'durable-reminder', adapter)
    const sources = [
      { kind: 'plugin', plugin: 'other', form: 'notice', summary: 'rollout budget reminder 9' },
      { kind: 'plugin', plugin: 'rollout-budget-controller' },
      { kind: 'plugin', plugin: 'rollout-budget-controller', form: 'notice' },
      { kind: 'plugin', plugin: 'rollout-budget-controller', form: 'notice', summary: 'not a reminder' },
      { kind: 'plugin', plugin: 'rollout-budget-controller', form: 'notice', summary: 'rollout budget reminder 1' },
      { kind: 'plugin', plugin: 'rollout-budget-controller', form: 'notice', summary: 'rollout budget reminder 2' },
    ] as const
    for (const source of sources) {
      agent.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'existing context' }],
        source: source as never,
      }), { surfaceOp: 'append' })
    }
    send(agent)
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(reminders(agent)).toHaveLength(5)
  })
})

describe('enforcement and weighting', () => {
  it('allows an Agent tool effect while the root budget remains available', async () => {
    const ctx = await harness({ limitTokens: 100, reminderAtRemainingTokens: [] })
    let executions = 0
    ctx.tools.register(defineContentToolFixture({
      name: 'within-budget',
      description: 'record one allowed effect',
      parameters: {},
      async execute() {
        executions += 1
        return [{ type: 'text', text: 'ran' }]
      },
    }))
    const adapter = new MockAdapter([
      toolCallResponse('call-allowed', 'within-budget', {}),
      textResponse('done'),
    ])
    const agent = createAgent(ctx, 'allowed-tool-budget', adapter)
    send(agent)
    await agent.whenIdle()
    expect(executions).toBe(1)
  })

  it('denies tool effects requested by the response that exhausts the budget', async () => {
    const ctx = await harness({ limitTokens: 15, reminderAtRemainingTokens: [5] })
    let executions = 0
    ctx.tools.register(defineContentToolFixture({
      name: 'effect',
      description: 'record one effect',
      parameters: {},
      async execute() {
        executions += 1
        return [{ type: 'text', text: 'ran' }]
      },
    }))
    const adapter = new MockAdapter([
      toolCallResponse('call-budget', 'effect', {}),
    ])
    const agent = createAgent(ctx, 'tool-budget', adapter)
    send(agent)
    await agent.whenIdle()

    expect(executions).toBe(0)
    expect(agent.session.events.find(event => event.type === 'tool/result'))
      .toMatchObject({ data: { message: { content: [{ isError: true }] } } })
    expect(adapter.requests).toHaveLength(1)
  })

  it('applies output and uncached-input weights without charging cache fields', async () => {
    const ctx = await harness({
      limitTokens: 31,
      reminderAtRemainingTokens: [10],
      samplingTokenWeight: 2,
      prefillTokenWeight: 1,
    })
    const cached = textResponse('1234567890').map(chunk => chunk.type === 'usage'
      ? { ...chunk, usage: { ...chunk.usage, cacheReadTokens: 100, cacheWriteTokens: 100 } }
      : chunk)
    const adapter = new MockAdapter([cached, textResponse('done')])
    const agent = createAgent(ctx, 'weighted', adapter)
    send(agent)
    await agent.whenIdle()
    send(agent, 'exhausted')
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
  })

  it('does not apply an agent budget to a direct tool execution with no Agent', async () => {
    const ctx = await harness({ limitTokens: 1, reminderAtRemainingTokens: [] })
    let executions = 0
    ctx.tools.register(defineContentToolFixture({
      name: 'ambient',
      description: 'ambient fixture',
      parameters: {},
      async execute() {
        executions += 1
        return [{ type: 'text', text: 'ok' }]
      },
    }))
    await ctx.tools.execute({
      callId: CallId('ambient-call'),
      name: 'ambient',
      arguments: {},
      signal: new AbortController().signal,
    })
    expect(executions).toBe(1)
  })
})

describe('configuration', () => {
  it.each([
    [{ reminderAtRemainingTokens: [1] } as Config, /limitTokens/],
    [{ limitTokens: 10, reminderAtRemainingTokens: [0] }, /reminderAtRemainingTokens/],
    [{ limitTokens: 10, reminderAtRemainingTokens: [10] }, /reminderAtRemainingTokens/],
    [{ limitTokens: 10, reminderAtRemainingTokens: [], samplingTokenWeight: -1 }, /samplingTokenWeight/],
    [{ limitTokens: 10, reminderAtRemainingTokens: [], prefillTokenWeight: Number.POSITIVE_INFINITY }, /prefillTokenWeight/],
  ])('fails loud for invalid config %#', async (config, message) => {
    await expect(harness(config)).rejects.toThrow(message)
  })

  it.each([
    [{ limitTokens: 0, reminderAtRemainingTokens: [] }, /limitTokens/],
    [{ limitTokens: 1.5, reminderAtRemainingTokens: [] }, /limitTokens/],
    [{ limitTokens: 10, reminderAtRemainingTokens: 'bad' } as unknown as Config, /reminderAtRemainingTokens/],
    [{ limitTokens: 10, reminderAtRemainingTokens: [1.5] }, /reminderAtRemainingTokens/],
    [{ limitTokens: 10, reminderAtRemainingTokens: [], samplingTokenWeight: Number.NaN }, /samplingTokenWeight/],
    [{ limitTokens: 10, reminderAtRemainingTokens: [], prefillTokenWeight: -1 }, /prefillTokenWeight/],
  ])('revalidates direct programmatic construction %#', (config, message) => {
    expect(() => { RolloutBudget.apply(new Context(), config) }).toThrow(message)
  })
})
