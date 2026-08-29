import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@relay-harness/cordis'
import { EvidenceId, SourceId } from '@relay-harness/rlh-context-engine'
import SqliteLongTermMemory from '@relay-harness/rlh-memory-sqlite'
import SessionStore, { SessionId } from '@relay-harness/rlh-session'
import { remoteMethods } from '@relay-harness/rlh-typert-protocol'
import MemoryCenterGateway from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function harness(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  ctx.on('session/flush', () => {})
  await ctx.plugin(SqliteLongTermMemory, { path: ':memory:' })
  await ctx.plugin(MemoryCenterGateway, { userId: 'user', agentId: 'agent' })
  return ctx
}

describe('MemoryCenterGateway', () => {
  it('publishes the complete management Remote vocabulary', async () => {
    const ctx = await harness()
    const gateway = ctx.get('memoryCenter') as MemoryCenterGateway
    expect(remoteMethods(gateway).map(item => item.method).sort()).toEqual([
      'approve', 'delete', 'list', 'read', 'reject', 'revise', 'search',
    ])
  })

  it('records the request but refuses the Memory revision when Session durability is absent', async () => {
    const ctx = new Context(); contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SqliteLongTermMemory, { path: ':memory:' })
    await ctx.plugin(MemoryCenterGateway, { userId: 'user', agentId: 'agent' })
    const session = ctx.sessions.create(SessionId('no-durability'), { meta: { cwd: '/workspace' } })
    const scope = { workspaceId: '/workspace', userId: 'user', agentId: 'agent' }
    const entry = await ctx.longTermMemory.remember({
      scope, kind: 'fact', content: 'Candidate without durable review', importance: 1, confidence: 0.4,
      trust: 'agent-proposed', status: 'candidate',
      evidence: [{ sessionId: session.id, eventSeqs: [0], verification: 'agent-proposal', excerpt: 'candidate' }],
    })
    await expect((ctx.get('memoryCenter') as MemoryCenterGateway).approve({
      sessionId: session.id, id: entry.id, expectedRevision: entry.revision,
    })).rejects.toThrow(/no Session durability listener/u)
    expect(session.events.at(-1)?.type).toBe('memory/governance-requested')
    expect(await ctx.longTermMemory.read(scope, entry.id)).toMatchObject({ revision: 1, status: 'candidate' })
  })

  it('lists expired governance state and correlates only admitted durable memory evidence', async () => {
    const ctx = await harness()
    const session = ctx.sessions.create(SessionId('session-a'), { meta: { cwd: '/workspace' } })
    const entry = await ctx.longTermMemory.remember({
      scope: { workspaceId: '/workspace', userId: 'user', agentId: 'agent' },
      kind: 'preference',
      content: 'Always show context provenance.',
      importance: 3,
      confidence: 0.7,
      trust: 'agent-proposed',
      status: 'candidate',
      validUntil: Date.now() + 60_000,
      evidence: [{ sessionId: session.id, eventSeqs: [0], verification: 'agent-proposal', excerpt: 'show context provenance' }],
    })
    session.append('context/prepared', {
      turn: 1,
      step: 1,
      plan: {
        purpose: 'agent_step', budget: { maxChars: 100, maxTokens: 100 },
        contributors: [{
          contributorId: 'memory-agent', eligible: true, reason: 'purpose_supported',
          budget: { maxChars: 100, maxTokens: 100, timeoutMs: 50 },
        }],
      },
      decisions: [{
        contributorId: 'memory-agent', messageId: 'memory-message' as never,
        outcome: 'selected', reasons: ['within_budget'],
      }],
      contributions: [{
        contributorId: 'memory-agent',
        messageId: 'memory-message' as never,
        messageEventSeqs: [0],
        evidence: [{
          evidenceId: EvidenceId(`memory:${entry.id}:1`),
          resource: { sourceId: SourceId('long-term-memory'), key: entry.id, revision: '1' },
          digest: 'digest',
          truncated: false,
          freshness: 'current',
          verification: 'verified',
        }],
      }],
    })
    const coldId = SessionId('persisted-cold')
    const coldEvents = session.events.map(event => ({
      ...structuredClone(event),
      ...(event.type !== 'context/prepared' ? {} : { time: event.time + 1 }),
    }))
    ctx.provide('sessionQuery', {
      listSessions: async () => [
        { header: session.header, live: true, persisted: true },
        { header: { ...session.header, id: coldId }, live: false, persisted: true },
      ],
      readSession: async (id: string) => ({
        session: id === coldId ? { ...session.header, id: coldId } : session.header,
        events: id === coldId ? coldEvents : [...session.events],
      }),
    } as never)
    const gateway = ctx.get('memoryCenter') as MemoryCenterGateway
    const snapshot = await gateway.list({ workspaceId: '/workspace', sessionId: session.id, statuses: ['candidate'] })
    expect(snapshot).toMatchObject({
      total: 1,
      usageCoverage: { status: 'complete', sessionsScanned: 2, sessionsFailed: 0 },
    })
    expect(snapshot.entries[0]).toMatchObject({ freshness: 'current' })
    expect(snapshot.entries[0]?.whyUsed).toEqual([
      expect.objectContaining({ sessionId: session.id, turn: 1, step: 1, eventSeq: 0, memoryRevision: 1, revisionState: 'current' }),
      expect.objectContaining({ sessionId: coldId, turn: 1, step: 1, eventSeq: 0, memoryRevision: 1, revisionState: 'current' }),
    ])
    await ctx.longTermMemory.revise({
      scope: entry.scope, id: entry.id, content: 'Always show exact context provenance.',
      evidence: [{ sessionId: session.id, eventSeqs: [0], verification: 'agent-proposal', excerpt: 'exact provenance' }],
    })
    const detail = await gateway.read({ workspaceId: '/workspace', sessionId: session.id, id: entry.id })
    expect(detail.memory.whyUsed).toEqual([
      expect.objectContaining({ memoryRevision: 1, revisionState: 'historical' }),
      expect.objectContaining({ memoryRevision: 1, revisionState: 'historical' }),
    ])
  })

  it('approves, revises, rejects, and tombstones through exact user-governance events', async () => {
    const ctx = await harness()
    const session = ctx.sessions.create(SessionId('session-b'), { meta: { cwd: '/workspace' } })
    const scope = { workspaceId: '/workspace', userId: 'user', agentId: 'agent' }
    const candidate = await ctx.longTermMemory.remember({
      scope,
      kind: 'fact',
      content: 'The project uses pnpm.',
      importance: 2,
      confidence: 0.6,
      trust: 'agent-proposed',
      status: 'candidate',
      evidence: [{ sessionId: session.id, eventSeqs: [0], verification: 'agent-proposal', excerpt: 'uses pnpm' }],
    })
    const gateway = ctx.get('memoryCenter') as MemoryCenterGateway
    const approved = await gateway.approve({ sessionId: session.id, id: candidate.id, expectedRevision: candidate.revision })
    expect(approved.memory.entry).toMatchObject({ status: 'active', trust: 'user-stated', revision: 2 })
    expect(approved.signals).toEqual([expect.objectContaining({ kind: 'user_confirmed' })])
    expect(session.events.at(-1)).toMatchObject({
      type: 'memory/governance-requested',
      data: { action: 'approve', memoryId: candidate.id },
    })

    const revised = await gateway.revise({
      sessionId: session.id,
      id: candidate.id,
      expectedRevision: approved.memory.entry.revision,
      content: 'The project uses pnpm 11.',
      summary: 'Package manager: pnpm 11',
      importance: 3,
      confidence: 1,
      validUntil: null,
    })
    expect(revised.memory.entry).toMatchObject({ content: 'The project uses pnpm 11.', revision: 3 })
    expect(revised.memory.entry.evidence.at(-1)).toMatchObject({ verification: 'user-statement' })

    const deleted = await gateway.delete({ sessionId: session.id, id: candidate.id, expectedRevision: revised.memory.entry.revision, reason: 'No longer relevant' })
    expect(deleted.memory.entry).toMatchObject({ status: 'tombstoned', revision: 4, tombstoneReason: 'No longer relevant' })
    expect(deleted.signals.map(item => item.kind)).toHaveLength(3)
    expect(deleted.signals.map(item => item.kind)).toEqual(expect.arrayContaining([
      'user_confirmed', 'user_confirmed', 'user_rejected',
    ]))

    const other = await ctx.longTermMemory.remember({
      scope,
      kind: 'fact',
      content: 'Candidate to reject.',
      importance: 1,
      confidence: 0.2,
      trust: 'agent-proposed',
      status: 'candidate',
      evidence: [{ sessionId: session.id, eventSeqs: [0], verification: 'agent-proposal', excerpt: 'candidate' }],
    })
    const rejected = await gateway.reject({ sessionId: session.id, id: other.id, expectedRevision: other.revision, reason: 'Incorrect inference' })
    expect(rejected.memory.entry).toMatchObject({ status: 'tombstoned', tombstoneReason: 'Incorrect inference' })
  })

  it('refuses a cross-workspace mutation even when the id exists', async () => {
    const ctx = await harness()
    const owner = ctx.sessions.create(SessionId('owner'), { meta: { cwd: '/workspace/a' } })
    const attacker = ctx.sessions.create(SessionId('other'), { meta: { cwd: '/workspace/b' } })
    const entry = await ctx.longTermMemory.remember({
      scope: { workspaceId: '/workspace/a', userId: 'user', agentId: 'agent' },
      kind: 'fact', content: 'Scoped fact', importance: 1, confidence: 0.5,
      trust: 'agent-proposed', status: 'candidate',
      evidence: [{ sessionId: owner.id, eventSeqs: [0], verification: 'agent-proposal', excerpt: 'Scoped fact' }],
    })
    const gateway = ctx.get('memoryCenter') as MemoryCenterGateway
    await expect(gateway.approve({ sessionId: attacker.id, id: entry.id, expectedRevision: entry.revision })).rejects.toThrow(/not found/)
  })

  it('derives read scope from the attached Session and rejects a Client-supplied mismatch', async () => {
    const ctx = await harness()
    const session = ctx.sessions.create(SessionId('scope-owner'), { meta: { cwd: '/workspace/a' } })
    const gateway = ctx.get('memoryCenter') as MemoryCenterGateway
    await expect(gateway.list({ workspaceId: '/workspace/b', sessionId: session.id }))
      .rejects.toThrow(/lookup policy rejected/u)
    await expect(gateway.read({ workspaceId: '/workspace/b', sessionId: session.id, id: 'unknown' }))
      .rejects.toThrow(/lookup policy rejected/u)
  })

  it('rejects stale and mid-flight governance revisions instead of overwriting newer user state', async () => {
    const ctx = await harness()
    const session = ctx.sessions.create(SessionId('revision-owner'), { meta: { cwd: '/workspace' } })
    const scope = { workspaceId: '/workspace', userId: 'user', agentId: 'agent' }
    const entry = await ctx.longTermMemory.remember({
      scope, kind: 'fact', content: 'Initial candidate', importance: 1, confidence: 0.4,
      trust: 'agent-proposed', status: 'candidate',
      evidence: [{ sessionId: session.id, eventSeqs: [0], verification: 'agent-proposal', excerpt: 'initial' }],
    })
    const revised = await ctx.longTermMemory.revise({
      scope, id: entry.id, content: 'Already revised', evidence: [{
        sessionId: session.id, eventSeqs: [0], verification: 'agent-proposal', excerpt: 'already revised',
      }],
    })
    const gateway = ctx.get('memoryCenter') as MemoryCenterGateway
    await expect(gateway.approve({ sessionId: session.id, id: entry.id, expectedRevision: entry.revision }))
      .rejects.toThrow(/revision conflict/u)

    let releaseFlush!: () => void
    const flushGate = new Promise<void>((resolve) => { releaseFlush = resolve })
    ctx.on('session/flush', async () => { await flushGate })
    const pending = gateway.approve({ sessionId: session.id, id: entry.id, expectedRevision: revised.revision })
    for (let attempt = 0; session.events.at(-1)?.type !== 'memory/governance-requested' && attempt < 100; attempt += 1) {
      await Promise.resolve()
    }
    expect(session.events.at(-1)?.type).toBe('memory/governance-requested')
    const newest = await ctx.longTermMemory.revise({
      scope, id: entry.id, content: 'Concurrent newer revision', evidence: [{
        sessionId: session.id, eventSeqs: [0], verification: 'agent-proposal', excerpt: 'concurrent',
      }],
    })
    releaseFlush()
    await expect(pending).rejects.toThrow(/revision conflict/u)
    expect(await ctx.longTermMemory.read(scope, entry.id)).toMatchObject({
      revision: newest.revision,
      content: 'Concurrent newer revision',
      status: 'candidate',
    })
  })

  it('merges deterministic normalized collisions with an optional attributed semantic detector', async () => {
    const ctx = await harness()
    const session = ctx.sessions.create(SessionId('review-conflicts'), { meta: { cwd: '/workspace' } })
    const scope = { workspaceId: '/workspace', userId: 'user', agentId: 'agent' }
    const target = await ctx.longTermMemory.remember({
      scope, kind: 'fact', content: 'The package manager is pnpm.', summary: 'Package manager',
      importance: 2, confidence: 0.6, trust: 'agent-proposed', status: 'candidate',
      evidence: [{ sessionId: session.id, eventSeqs: [0], verification: 'agent-proposal', excerpt: 'pnpm' }],
    })
    const normalized = await ctx.longTermMemory.remember({
      scope, kind: 'fact', content: 'The package manager is npm.', summary: ' package   MANAGER ',
      importance: 2, confidence: 0.6, trust: 'agent-proposed', status: 'candidate',
      evidence: [{ sessionId: session.id, eventSeqs: [0], verification: 'agent-proposal', excerpt: 'npm' }],
    })
    const semantic = await ctx.longTermMemory.remember({
      scope, kind: 'fact', content: 'Use yarn for package installation.', summary: 'Install dependencies',
      importance: 2, confidence: 0.6, trust: 'agent-proposed', status: 'candidate',
      evidence: [{ sessionId: session.id, eventSeqs: [0], verification: 'agent-proposal', excerpt: 'yarn' }],
    })
    ctx.provide('memoryConflictDetector', {
      detect: async () => [{
        entry: semantic,
        relation: 'semantic-conflict',
        score: 0.9,
        reasons: ['provider-attributed package-manager contradiction'],
        detectorId: 'test-semantic-v1',
      }],
    } as never)
    const detail = await (ctx.get('memoryCenter') as MemoryCenterGateway).read({
      workspaceId: scope.workspaceId,
      sessionId: session.id,
      id: target.id,
    })
    expect(detail.conflicts.find(item => item.relation === 'normalized-summary-collision')?.entry.entry.id)
      .toBe(normalized.id)
    expect(detail.conflicts.find(item => item.relation === 'semantic-conflict')).toMatchObject({
      detectorId: 'test-semantic-v1',
    })
    expect(detail.conflicts.find(item => item.relation === 'semantic-conflict')?.entry.entry.id)
      .toBe(semantic.id)
  })

  it('restarts governance pagination when a concurrent revision reorders page boundaries', async () => {
    const ctx = await harness()
    const session = ctx.sessions.create(SessionId('pagination-review'), { meta: { cwd: '/workspace' } })
    const scope = { workspaceId: '/workspace', userId: 'user', agentId: 'agent' }
    for (let index = 0; index < 51; index += 1) {
      await ctx.longTermMemory.remember({
        scope, kind: 'fact', content: `Pagination item ${index}`, importance: 1, confidence: 0.4,
        trust: 'agent-proposed', status: 'candidate',
        evidence: [{ sessionId: session.id, eventSeqs: [0], verification: 'agent-proposal', excerpt: `item ${index}` }],
      })
    }
    const provider = ctx.longTermMemory
    const original = provider.list.bind(provider)
    const tail = (await original({ scope, limit: 50, offset: 50, includeExpired: true })).entries[0]!
    let calls = 0
    provider.list = async (input, signal) => {
      calls += 1
      const page = await original(input, signal)
      if (calls === 1) {
        await provider.revise({
          scope, id: tail.id, content: `${tail.content} revised`,
          evidence: [{ sessionId: session.id, eventSeqs: [0], verification: 'agent-proposal', excerpt: 'revised' }],
        })
      }
      return page
    }
    const snapshot = await (ctx.get('memoryCenter') as MemoryCenterGateway).search({
      workspaceId: scope.workspaceId, sessionId: session.id, query: 'Pagination', limit: 50,
    })
    expect(snapshot).toMatchObject({ total: 51, hasMore: true })
    expect(new Set(snapshot.entries.map(item => item.entry.id)).size).toBe(50)
    expect(calls).toBeGreaterThanOrEqual(4)
  })
})
