import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@relay-harness/cordis'
import { EvidenceId, SourceId } from '@relay-harness/rlh-context-engine'
import type {} from '@relay-harness/rlh-context-engine/types'
import type {} from '@relay-harness/rlh-goal'
import MemoryOutcomeReconciler from '@relay-harness/rlh-memory-outcome-reconciler'
import SqliteLongTermMemory from '@relay-harness/rlh-memory-sqlite'
import SessionStore, { SessionId, type SessionEvent, type SessionHeader } from '@relay-harness/rlh-session'
import MemoryCenterGateway from '../src/index.ts'

let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

describe('Memory Center vertical slice', () => {
  it('moves an extracted candidate through Host governance and back into the scoped product read', async () => {
    ctx = new Context()
    await ctx.plugin(SessionStore)
    ctx.on('session/flush', () => {})
    await ctx.plugin(SqliteLongTermMemory, { path: ':memory:' })
    await ctx.plugin(MemoryCenterGateway, { userId: 'local-user', agentId: 'relay-harness' })
    const session = ctx.sessions.create(SessionId('memory-center-e2e'), { meta: { cwd: '/e2e/workspace' } })
    const candidate = await ctx.longTermMemory.remember({
      scope: { workspaceId: '/e2e/workspace', userId: 'local-user', agentId: 'relay-harness' },
      kind: 'constraint',
      content: 'Use Simplified Chinese for user-visible text.',
      importance: 4,
      confidence: 0.8,
      trust: 'agent-proposed',
      status: 'candidate',
      evidence: [{
        sessionId: session.id,
        eventSeqs: [0],
        verification: 'agent-proposal',
        excerpt: 'Use Simplified Chinese',
      }],
    })
    const gateway = ctx.get('memoryCenter') as MemoryCenterGateway
    expect((await gateway.search({ workspaceId: '/e2e/workspace', sessionId: session.id, query: 'Simplified Chinese' })).entries[0]?.entry.id)
      .toBe(candidate.id)

    await gateway.approve({ sessionId: session.id, id: candidate.id, expectedRevision: candidate.revision })
    const active = await gateway.list({ workspaceId: '/e2e/workspace', sessionId: session.id, statuses: ['active'] })
    expect(active.entries[0]?.entry).toMatchObject({
      id: candidate.id,
      status: 'active',
      trust: 'user-stated',
      revision: 2,
    })
    expect(session.events.at(-1)?.type).toBe('memory/governance-requested')
  })

  it('projects persisted cross-session use and explicit outcomes through one product detail read', async () => {
    ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SqliteLongTermMemory, { path: ':memory:' })
    const sessionId = SessionId('memory-history-e2e')
    const scope = { workspaceId: '/e2e/history', userId: 'local-user', agentId: 'relay-harness' }
    const candidate = await ctx.longTermMemory.remember({
      scope, kind: 'lesson', content: 'Run focused tests before delivery.', importance: 3, confidence: 0.8,
      trust: 'agent-proposed', status: 'candidate',
      evidence: [{ sessionId, eventSeqs: [0], verification: 'agent-proposal', excerpt: 'Run focused tests' }],
    })
    const header = { version: 0, id: sessionId, createdAt: 1, cwd: scope.workspaceId } satisfies SessionHeader
    const events = outcomeEvents(candidate.id)
    ctx.provide('sessionQuery', {
      listSessions: async () => [{ header, live: false, persisted: true }],
      readSession: async () => ({ session: header, events }),
    } as never)
    ctx.provide('messageFeedback', {
      list: async () => ({ ok: true, value: { items: [{
        messageId: 'assistant-history', rating: 'positive', version: 'feedback-v1', createdAt: 4, updatedAt: 5,
      }] } }),
    } as never)
    await ctx.plugin(MemoryOutcomeReconciler, { userId: scope.userId, agentId: scope.agentId })
    await ctx.plugin(MemoryCenterGateway, { userId: scope.userId, agentId: scope.agentId })
    const reviewSession = ctx.sessions.create(SessionId('memory-history-review'), { meta: { cwd: scope.workspaceId } })
    const detail = await (ctx.get('memoryCenter') as MemoryCenterGateway).read({
      workspaceId: scope.workspaceId,
      sessionId: reviewSession.id,
      id: candidate.id,
    })
    expect(detail.usageCoverage).toEqual({ status: 'complete', sessionsScanned: 1, sessionsFailed: 0 })
    expect(detail.memory.whyUsed).toEqual([expect.objectContaining({ sessionId, eventSeq: 1 })])
    expect(detail.outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'assistant-positive', impact: 'positive' }),
      expect.objectContaining({ kind: 'work-completed', impact: 'positive' }),
      expect.objectContaining({ kind: 'turn-completed', impact: 'neutral' }),
    ]))
    expect(detail.outcomeSummary).toMatchObject({ positive: 2, neutral: 1, rankingAdjustment: 0.05 })
  })
})

function outcomeEvents(memoryId: string): SessionEvent[] {
  return [
    {
      type: 'goal/change', seq: 0, time: 1,
      data: {
        kind: 'goal/change', version: 1, operation: 'create',
        goal: { id: 'goal-history', revision: 1, objective: 'Validate', phase: 'active', maxGoalRounds: 5 },
        roundsStarted: 0, createdAt: 1, updatedAt: 1,
      },
    },
    {
      type: 'context/prepared', seq: 1, time: 2,
      data: { turn: 1, step: 1, contributions: [{
        contributorId: 'memory-agent', messageId: 'memory-context' as never, messageEventSeqs: [0],
        evidence: [{
          evidenceId: EvidenceId(`memory:${memoryId}:1`),
          resource: { sourceId: SourceId('long-term-memory'), key: memoryId, revision: '1' },
          digest: 'digest', truncated: false, freshness: 'current', verification: 'verified',
        }],
      }] },
    },
    {
      type: 'assistant/message', seq: 2, time: 3,
      data: { turn: 1, step: 1, message: { id: 'assistant-history', role: 'assistant', content: [], finishReason: 'stop' } },
    },
    { type: 'turn/end', seq: 3, time: 4, data: { turn: 1, reason: { kind: 'completed' } } },
    {
      type: 'goal/change', seq: 4, time: 5,
      data: {
        kind: 'goal/change', version: 1, operation: 'complete',
        goal: { id: 'goal-history', revision: 2, objective: 'Validate', phase: 'complete', maxGoalRounds: 5 },
        roundsStarted: 1, createdAt: 1, updatedAt: 5,
      },
    },
  ] as unknown as SessionEvent[]
}
