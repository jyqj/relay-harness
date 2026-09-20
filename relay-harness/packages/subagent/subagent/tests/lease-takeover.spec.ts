/**
 * Full-stack §11.2 scenario: a subagent's activation lease is taken over by a
 * new owner while the old instance holds the child resident, the old
 * instance's durable write is rejected at the persistence fence, the
 * successor proceeds through the real activation path, and the old
 * instance's teardown cannot damage the new owner.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@relay-harness/cordis'
import type { Agent } from '@relay-harness/rlh-agent'
import AgentLoop from '@relay-harness/rlh-agent-loop'
import { mountAgentLoopTestDependencies } from '@relay-harness/rlh-agent-loop-testkit'
import type { GenerateOptions, StreamChunk } from '@relay-harness/rlh-llm'
import { LlmAdapter } from '@relay-harness/rlh-llm'
import { SessionId } from '@relay-harness/rlh-session'
import type { SessionEvent } from '@relay-harness/rlh-session'
import JsonlSessionPersistence from '@relay-harness/rlh-session-persistence-jsonl'
import * as SubagentSpawn from '@relay-harness/rlh-subagent-spawn-in-process'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import SubagentRuntime, { SubagentActivationLeaseStore } from '../src/index.ts'

/** Adapter whose single response holds the child's model call open until released. */
class GatedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly gate: Promise<undefined>) { super() }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    await this.gate
    yield* textResponse('never streamed; the takeover fences this owner first')
  }
}

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose().catch(() => undefined)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

/** Boot one full owner stack: loop, JSONL persistence, lease-configured runtime, and spawn provider. */
async function bootOwner(root: string, leasePath: string, gate?: Promise<undefined>) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime, {
    activationLeasePath: leasePath, activationLeaseMs: 5_000, activationLeaseRenewMs: 25,
  })
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  const adapter: LlmAdapter = gate === undefined
    ? new MockAdapter([textResponse('successor result')])
    : new GatedAdapter(gate)
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = ctx.agentLoop.create(SessionId('takeover-parent'), { provider: 'mock', model: 'mock' })
  return { ctx, parent, adapter }
}

/** Keep the scripted corpus for children only: a settling child wakes its parent. */
function parkParent(owner: { ctx: Context; parent: Agent }): void {
  owner.ctx.on('agent/pre-step', async ({ agent: subject }, next) => {
    if (subject !== owner.parent) return next()
    return { kind: 'reject' as const }
  })
}

function startSpec(parent: Agent) {
  return {
    provider: 'spawn',
    label: 'leased child task',
    request: { prompt: [{ type: 'text' as const, text: 'child task' }], parent },
    signal: new AbortController().signal,
  }
}

function message(text: string) {
  return [{ type: 'text' as const, text }]
}

async function waitNoActivation(ctx: Context, childId: SessionId): Promise<void> {
  await vi.waitFor(() => { expect(ctx.agents.get(childId)).toBeUndefined() }, { timeout: 5_000 })
}

/** User-authored message texts in the persisted log, in order. */
function userTexts(events: readonly SessionEvent[]): string[] {
  return events.flatMap(event => event.type === 'user/message' && event.data.source.kind !== 'plugin'
    ? event.data.content.flatMap(block => block.type === 'text' ? [block.text] : [])
    : [])
}

describe('activation-lease takeover across owner instances', () => {
  it('fences the old-owner durable write while the successor proceeds and the old teardown stays harmless', { timeout: 20_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'rlh-lease-takeover-e2e-'))
    roots.push(root)
    const leasePath = join(root, 'activation-leases.sqlite3')
    const hold = Promise.withResolvers<undefined>()
    const old = await bootOwner(root, leasePath, hold.promise)
    parkParent(old)

    const started = await old.ctx.subagents.startContinuable(startSpec(old.parent))
    const childId = started.childId
    await vi.waitFor(() => { expect(old.adapter.requests).toHaveLength(1) })

    const contender = new SubagentActivationLeaseStore(leasePath)
    let successor: ReturnType<SubagentActivationLeaseStore['acquire']> | undefined
    try {
      successor = contender.acquire(childId, 5_000, Date.now() + 120_000)
      expect(successor.fence).toBe(2)

      // The old instance's durable write is rejected at the persistence fence:
      // a stale owner cannot even grow the in-memory log.
      const staleSession = old.ctx.agents.get(childId)
      if (staleSession === undefined) throw new Error('old owner lost its resident child unexpectedly')
      expect(() => staleSession.session.append('turn/start', { turn: 99 }))
        .toThrow(/no longer owned by this Harness/)
      const stored = await old.ctx.sessionPersistence.readFrom(childId, 0)
      expect(userTexts(stored.events)).not.toContain('stale write')
      expect(() => { contender.assertCurrent(successor, Date.now()) }).not.toThrow()

      // The old runtime's renewal detects the loss and retires the resident child
      // without revoking the successor's lease.
      hold.resolve(undefined)
      await waitNoActivation(old.ctx, childId)
      expect(() => { contender.assertCurrent(successor, Date.now()) }).not.toThrow()

      // The successor proceeds through the real activation path and commits durably.
      successor.release()
      successor = undefined
      const next = await bootOwner(root, leasePath)
      parkParent(next)
      await next.ctx.subagents.followup(next.parent, childId, message('successor work'), {
        source: { kind: 'user' }, signal: new AbortController().signal,
      })
      await waitNoActivation(next.ctx, childId)
      const succeeded = await next.ctx.sessionPersistence.readFrom(childId, 0)
      expect(userTexts(succeeded.events)).toContain('successor work')
      expect(userTexts(succeeded.events)).not.toContain('stale write')
      expect(succeeded.events.some(event => event.type === 'assistant/message')).toBe(true)
      expect(old.ctx.agents.get(childId)).toBeUndefined()

      // The old instance's final disposal cannot damage the successor's commit.
      contexts.splice(contexts.indexOf(old.ctx), 1)
      await old.ctx.fiber.dispose()
      const afterTeardown = await next.ctx.sessionPersistence.readFrom(childId, 0)
      expect(userTexts(afterTeardown.events)).toContain('successor work')
    } finally {
      try { successor?.release() } catch { /* A takeover already fenced this owner. */ }
      hold.resolve(undefined)
      contender.close()
    }
  })
})
