import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@relay-harness/cordis'
import type {} from '@relay-harness/rlh-context-engine/types'
import type {} from '@relay-harness/rlh-goal'
import { EvidenceId, SourceId } from '@relay-harness/rlh-context-engine'
import SqliteLongTermMemory from '@relay-harness/rlh-memory-sqlite'
import { SessionId, type SessionEvent, type SessionHeader } from '@relay-harness/rlh-session'
import MemoryOutcomeReconciler from '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

describe('MemoryOutcomeReconciler', () => {
  it('derives neutral turn, explicit message rating, and Work completion without activating a Session', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SqliteLongTermMemory, { path: ':memory:' })
    const sessionId = SessionId('persisted-outcome')
    const scope = { workspaceId: '/workspace', userId: 'user', agentId: 'agent' }
    const memory = await ctx.longTermMemory.remember({
      scope,
      kind: 'lesson',
      content: 'Run validation before completion.',
      importance: 3,
      confidence: 0.8,
      trust: 'agent-proposed',
      status: 'candidate',
      evidence: [{ sessionId, eventSeqs: [0], verification: 'agent-proposal', excerpt: 'Run validation' }],
    })
    const events = sessionEvents(memory.id)
    const header = { version: 0, id: sessionId, createdAt: 1, cwd: '/workspace' } satisfies SessionHeader
    const listSessions = vi.fn(async () => [{ header, live: false, persisted: true }])
    const readSession = vi.fn(async () => ({ session: header, events }))
    ctx.provide('sessionQuery', { listSessions, readSession } as never)
    let rating: 'positive' | 'negative' = 'positive'
    let feedbackAvailable = true
    ctx.provide('messageFeedback', {
      list: async () => feedbackAvailable ? ({
        ok: true, value: { items: [{ messageId: 'assistant-1', rating, version: 'v1', createdAt: 10, updatedAt: 11 }] },
      }) : ({ ok: false, error: { code: 'session-not-found', sessionId } }),
    } as never)
    await ctx.plugin(MemoryOutcomeReconciler, { userId: 'user', agentId: 'agent', concurrency: 2 })
    await ctx.memoryOutcomeReconciler.ensureReconciled()

    expect(listSessions).toHaveBeenCalledTimes(1)
    expect(readSession).toHaveBeenCalledWith(sessionId)
    expect(ctx.get('sessions')).toBeUndefined()
    let outcomes = await ctx.longTermMemory.listOutcomes({ scope, id: memory.id, limit: 10 })
    expect(outcomes.map(item => [item.kind, item.impact])).toEqual([
      ['assistant-positive', 'positive'],
      ['work-completed', 'positive'],
      ['turn-completed', 'neutral'],
    ])

    rating = 'negative'
    ctx.emit('message-feedback/changed', { sessionId, messageId: 'assistant-1' as never, rating })
    await vi.waitFor(async () => {
      const current = await ctx.longTermMemory.listOutcomes({ scope, id: memory.id, limit: 10 })
      expect(current).toContainEqual(expect.objectContaining({ kind: 'assistant-negative' }))
    })
    outcomes = await ctx.longTermMemory.listOutcomes({ scope, id: memory.id, limit: 10 })
    expect(outcomes.some(item => item.kind === 'assistant-positive')).toBe(false)
    expect(outcomes).toContainEqual(expect.objectContaining({ kind: 'assistant-negative', impact: 'negative' }))

    feedbackAvailable = false
    await expect(ctx.memoryOutcomeReconciler.reconcileSession(sessionId)).rejects.toThrow(/feedback unavailable/u)
    expect(await ctx.longTermMemory.listOutcomes({ scope, id: memory.id, limit: 10 }))
      .toContainEqual(expect.objectContaining({ kind: 'assistant-negative', impact: 'negative' }))
  })

  it('retries a failed full reconciliation instead of memoizing an unavailable corpus forever', async () => {
    const ctx = new Context(); contexts.push(ctx)
    await ctx.plugin(SqliteLongTermMemory, { path: ':memory:' })
    let available = false
    const listSessions = vi.fn(async () => {
      if (!available) throw new Error('corpus temporarily unavailable')
      return []
    })
    ctx.provide('sessionQuery', { listSessions } as never)
    ctx.provide('messageFeedback', { list: async () => ({ ok: true, value: { items: [] } }) } as never)
    await ctx.plugin(MemoryOutcomeReconciler)
    await expect(ctx.memoryOutcomeReconciler.ensureReconciled()).rejects.toThrow(/temporarily unavailable/u)
    available = true
    await expect(ctx.memoryOutcomeReconciler.ensureReconciled()).resolves.toBeUndefined()
    expect(listSessions.mock.calls.length).toBeGreaterThanOrEqual(2)
    const refresh = ctx.memoryOutcomeReconciler.ensureReconciled(true)
    expect(ctx.memoryOutcomeReconciler.ensureReconciled(true)).toBe(refresh)
    await refresh
  })
})

function sessionEvents(memoryId: string): SessionEvent[] {
  return [
    {
      type: 'goal/change', seq: 0, time: 1,
      data: {
        kind: 'goal/change', version: 1, operation: 'create',
        goal: { id: 'goal-1', revision: 1, objective: 'Finish', phase: 'active', maxGoalRounds: 5 },
        roundsStarted: 0, createdAt: 1, updatedAt: 1,
      },
    },
    {
      type: 'context/prepared', seq: 1, time: 2,
      data: {
        turn: 1,
        step: 1,
        contributions: [{
          contributorId: 'memory-agent',
          messageId: 'memory-message' as never,
          messageEventSeqs: [0],
          evidence: [{
            evidenceId: EvidenceId(`memory:${memoryId}:1`),
            resource: { sourceId: SourceId('long-term-memory'), key: memoryId, revision: '1' },
            digest: 'digest', truncated: false, freshness: 'current', verification: 'verified',
          }],
        }],
      },
    },
    {
      type: 'assistant/message', seq: 2, time: 3,
      data: { turn: 1, step: 1, message: { id: 'assistant-1', role: 'assistant', content: [], finishReason: 'stop' } },
    },
    { type: 'turn/end', seq: 3, time: 4, data: { turn: 1, reason: { kind: 'completed' } } },
    {
      type: 'goal/change', seq: 4, time: 5,
      data: {
        kind: 'goal/change', version: 1, operation: 'complete',
        goal: { id: 'goal-1', revision: 2, objective: 'Finish', phase: 'complete', maxGoalRounds: 5 },
        roundsStarted: 1, createdAt: 1, updatedAt: 4,
      },
    },
  ] as unknown as SessionEvent[]
}
