import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as CircuitBreakerPlugin from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { ScriptAdapter } from './support.ts'

async function harness(config: Config, adapters: Record<string, ScriptAdapter>) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(CircuitBreakerPlugin, config)
  for (const [provider, adapter] of Object.entries(adapters)) ctx.llm.registerAdapter([provider], adapter)
  return ctx
}

function send(agent: Agent): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
}

afterEach(() => { vi.useRealTimers() })

describe('llm-circuit-breaker plugin', () => {
  it('sheds an open provider, admits a half-open success, and closes', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const adapter = new ScriptAdapter(['server', 'server', 'success', 'success'])
    const ctx = await harness({ minSamples: 2, errorRateThreshold: 1, openMs: 100 }, { p: adapter })
    const agent = ctx.agentLoop.create(SessionId('breaker'), { provider: 'p', model: 'm' })
    send(agent); await agent.whenIdle()
    send(agent); await agent.whenIdle()
    send(agent); await agent.whenIdle()
    expect(adapter.calls).toBe(2)
    expect(agent.session.events.findLast(event => event.type === 'turn/end'))
      .toMatchObject({ data: { reason: { kind: 'error', error: { code: 'CIRCUIT_OPEN' } } } })

    vi.setSystemTime(100)
    send(agent); await agent.whenIdle()
    send(agent); await agent.whenIdle()
    expect(adapter.calls).toBe(4)
  })

  it('isolates providers and treats unconfigured failure codes as successful connectivity samples', async () => {
    const first = new ScriptAdapter(['auth', 'server', 'success'])
    const second = new ScriptAdapter(['success'])
    const ctx = await harness({ minSamples: 2, errorRateThreshold: 1 }, { first, second })
    const agent = ctx.agentLoop.create(SessionId('first'), { provider: 'first', model: 'm' })
    send(agent); await agent.whenIdle()
    send(agent); await agent.whenIdle()
    send(agent); await agent.whenIdle()
    expect(first.calls).toBe(3)
    const peer = ctx.agentLoop.create(SessionId('second'), { provider: 'second', model: 'm' })
    send(peer); await peer.whenIdle()
    expect(second.calls).toBe(1)
  })

  it.each([
    [{ windowMs: 0 }, /windowMs/],
    [{ minSamples: 1.5 }, /minSamples/],
    [{ openMs: 0 }, /openMs/],
    [{ halfOpenMaxProbes: 0 }, /halfOpenMaxProbes/],
    [{ errorRateThreshold: Number.NaN }, /errorRateThreshold/],
    [{ failureCodes: ['SERVER', 'SERVER'] }, /failureCodes/],
    [{ failureCodes: [''] }, /failureCodes/],
  ])('fails loud on invalid config %#', async (config, message) => {
    await expect(harness(config, {})).rejects.toThrow(message)
  })

  it.each([
    [{ windowMs: 0 }, /windowMs/],
    [{ minSamples: 1.5 }, /minSamples/],
  ])('revalidates direct construction %#', (override, message) => {
    expect(() => {
      CircuitBreakerPlugin.apply(new Context(), {
        windowMs: 60_000,
        minSamples: 5,
        errorRateThreshold: 0.5,
        openMs: 60_000,
        halfOpenMaxProbes: 1,
        failureCodes: ['SERVER'],
        ...override,
      })
    }).toThrow(message)
  })
})
