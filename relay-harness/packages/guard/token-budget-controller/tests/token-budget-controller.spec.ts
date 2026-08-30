import { describe, expect, it } from 'vitest'
import { Context } from '@relay-harness/cordis'
import { createUserMessage } from '@relay-harness/rlh-llm'
import type { StreamChunk } from '@relay-harness/rlh-llm'
import { SessionId, type SessionEvent } from '@relay-harness/rlh-session'
import type { Agent } from '@relay-harness/rlh-agent'
import AgentLoop from '@relay-harness/rlh-agent-loop'
import { mountAgentLoopTestDependencies } from '@relay-harness/rlh-agent-loop-testkit'
import * as TokenBudgetController from '@relay-harness/rlh-token-budget-controller'
import type { Config } from '@relay-harness/rlh-token-budget-controller'
import { MockAdapter, maxTokensResponse, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/**
 * Behavior suite for the token budget controller: continuation on a
 * max-tokens cutoff, the per-turn continuation cap, diminishing-returns
 * detection (including unreported usage), non-cutoff turns left alone, and
 * fail-loud config validation — all driven through a real agent loop against
 * a scripted mock adapter (no network).
 */

/** Boot the core spine + the controller; the caller registers adapters. */
async function harness(config: Config = {}): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TokenBudgetController, config)
  return ctx
}

function startAgent(ctx: Context, adapter: MockAdapter, id: string): Agent {
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = ctx.agentLoop.create(SessionId(id), { provider: 'mock', model: 'mock' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
  return agent
}

/** Every controller-steered nudge in the agent's log, flattened for terse assertions. */
function nudges(agent: Agent): { text: string; source: unknown }[] {
  return [...agent.session.events]
    .filter((e): e is SessionEvent<'user/message'> => e.type === 'user/message'
      && e.data.source.kind === 'plugin')
    .map(e => ({
      text: e.data.content.map(block => block.type === 'text' ? block.text : '').join('|'),
      source: e.data.source,
    }))
}

/** A max-tokens cutoff response whose stream reports no usage chunk. */
function usagelessMaxTokensResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ]
}

const nudgeSource = (continuation: number) => ({
  kind: 'plugin',
  plugin: 'token-budget-controller',
  form: 'notice',
  summary: `continuation ${continuation}`,
})

describe('continuation on max-tokens', () => {
  it('steers a continue nudge when the turn closes on a cutoff', async () => {
    const ctx = await harness()
    const agent = startAgent(ctx, new MockAdapter([
      maxTokensResponse('the first part of the answer'),
      textResponse('the rest of the answer'),
    ]), 'tb-continue')
    await agent.whenIdle()

    const found = nudges(agent)
    expect(found).toHaveLength(1)
    expect(found[0]!.text).toContain('cut off at the output token limit')
    expect(found[0]!.source).toEqual(nudgeSource(1))
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'the rest of the answer' }],
    })
  })

  it('fails the turn before a model request beyond maxStepsPerTurn', async () => {
    const ctx = await harness({ maxContinuations: 8, maxStepsPerTurn: 2 })
    const agent = startAgent(ctx, new MockAdapter([
      maxTokensResponse('one'),
      maxTokensResponse('two'),
      textResponse('must not run'),
    ]), 'tb-step-cap')
    await agent.whenIdle()

    expect(agent.session.events.filter(event => event.type === 'step/start')).toHaveLength(2)
    expect(agent.session.events.filter(event => event.type === 'assistant/message')).toHaveLength(2)
    const turnEnd = agent.session.events.findLast(event => event.type === 'turn/end')
    expect(turnEnd?.data.reason.kind).toBe('error')
    if (turnEnd?.data.reason.kind !== 'error') throw new Error('expected an error turn end')
    expect(turnEnd.data.reason.error.message).toContain('turn step budget exhausted at 2')
  })

  it('leaves a normally finished turn alone', async () => {
    const ctx = await harness()
    const agent = startAgent(ctx, new MockAdapter([
      textResponse('complete in one go'),
    ]), 'tb-stop')
    await agent.whenIdle()

    expect(nudges(agent)).toHaveLength(0)
  })

  it('stops steering after maxContinuations cutoffs in one turn', async () => {
    const ctx = await harness({ maxContinuations: 2 })
    const agent = startAgent(ctx, new MockAdapter([
      maxTokensResponse('one'),
      maxTokensResponse('two'),
      maxTokensResponse('three'),
    ]), 'tb-cap')
    await agent.whenIdle()

    expect(nudges(agent).map(nudge => nudge.source)).toEqual([nudgeSource(1), nudgeSource(2)])
  })

  it('resets the continuation count on a new turn', async () => {
    const ctx = await harness({ maxContinuations: 1 })
    const adapter = new MockAdapter([
      maxTokensResponse('turn one cut'),
      textResponse('turn one done'),
      maxTokensResponse('turn two cut'),
      textResponse('turn two done'),
    ])
    const agent = startAgent(ctx, adapter, 'tb-new-turn')
    await agent.whenIdle()
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'again' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(nudges(agent)).toHaveLength(2)
  })
})

describe('diminishing-returns detection', () => {
  it('stops steering after maxLowDeltaStreak unproductive continuations', async () => {
    const ctx = await harness({ minUsefulDeltaTokens: 500, maxLowDeltaStreak: 2 })
    const agent = startAgent(ctx, new MockAdapter([
      maxTokensResponse('x'.repeat(600)),
      maxTokensResponse('short'),
      maxTokensResponse('tiny'),
    ]), 'tb-diminishing')
    await agent.whenIdle()

    expect(nudges(agent)).toHaveLength(2)
  })

  it('keeps steering while continuations stay productive', async () => {
    const ctx = await harness({ minUsefulDeltaTokens: 500, maxLowDeltaStreak: 2, maxContinuations: 3 })
    const agent = startAgent(ctx, new MockAdapter([
      maxTokensResponse('x'.repeat(600)),
      maxTokensResponse('y'.repeat(600)),
      maxTokensResponse('z'.repeat(600)),
      textResponse('done'),
    ]), 'tb-productive')
    await agent.whenIdle()

    expect(nudges(agent)).toHaveLength(3)
  })

  it('treats unreported usage as productive (the cap alone bounds those)', async () => {
    const ctx = await harness({ minUsefulDeltaTokens: 500, maxLowDeltaStreak: 2 })
    const agent = startAgent(ctx, new MockAdapter([
      usagelessMaxTokensResponse('one'),
      usagelessMaxTokensResponse('two'),
      usagelessMaxTokensResponse('three'),
      textResponse('done'),
    ]), 'tb-usageless')
    await agent.whenIdle()

    expect(nudges(agent)).toHaveLength(3)
  })
})

describe('fail-loud config validation', () => {
  it.each([
    [{ maxContinuations: 0 }, /maxContinuations/],
    [{ maxContinuations: 1.5 }, /maxContinuations/],
    [{ minUsefulDeltaTokens: 0 }, /minUsefulDeltaTokens/],
    [{ maxLowDeltaStreak: 0 }, /maxLowDeltaStreak/],
    [{ maxStepsPerTurn: 0 }, /maxStepsPerTurn/],
  ] as const)('rejects invalid config %#', async (config, message) => {
    await expect(harness(config)).rejects.toThrow(message)
  })
})
