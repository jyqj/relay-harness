import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import { MemoryId } from '@deepseek-ai/dsh-memory'
import type { MemoryEvidence, MemoryScope } from '@deepseek-ai/dsh-memory/types'
import SqliteLongTermMemory from '@deepseek-ai/dsh-memory-sqlite'
import { SessionId } from '@deepseek-ai/dsh-session'

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-memory-'))
  temporaryDirectories.push(directory)
  return join(directory, 'memory.db')
}

async function harness(path = ':memory:'): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SqliteLongTermMemory, { path })
  return ctx
}

const scope: MemoryScope = { workspaceId: '/workspace/a', userId: 'user-a', agentId: 'agent-a' }
const userEvidence: MemoryEvidence = {
  sessionId: SessionId('session-a'),
  eventSeqs: [2],
  verification: 'user-statement',
  excerpt: 'validation drink is lapsang',
}
const toolEvidence: MemoryEvidence = {
  sessionId: SessionId('session-a'),
  eventSeqs: [5, 6],
  verification: 'successful-tool-result',
  callId: CallId('call-verified'),
  excerpt: 'tests passed',
}

describe('SQLite long-term memory', () => {
  it('persists active revisions, searches both lexical indexes, and tombstones without deleting evidence', async () => {
    const path = await databasePath()
    const ctx = await harness(path)
    const created = await ctx.longTermMemory.remember({
      scope,
      kind: 'preference',
      content: 'The user validation drink is lapsang souchong.',
      summary: 'Validation drink: lapsang souchong',
      importance: 3,
      confidence: 1,
      trust: 'user-stated',
      status: 'active',
      evidence: [userEvidence],
    })

    const unicode = await ctx.longTermMemory.search({ scope, query: 'validation drink', limit: 10 })
    expect(unicode).toHaveLength(1)
    expect(unicode[0]?.matchedBy).toContain('fts_unicode')
    const trigram = await ctx.longTermMemory.search({ scope, query: 'lapsang', limit: 10 })
    expect(trigram[0]?.matchedBy).toContain('fts_trigram')

    const revised = await ctx.longTermMemory.revise({
      scope,
      id: created.id,
      content: 'The user validation drink is smoked lapsang souchong.',
      trust: 'action-verified',
      confidence: 0.95,
      evidence: [toolEvidence],
    })
    expect(revised.revision).toBe(2)
    expect(revised.evidence).toHaveLength(2)

    const forgotten = await ctx.longTermMemory.forget({
      scope,
      id: created.id,
      reason: 'user requested deletion',
      evidence: [userEvidence],
    })
    expect(forgotten).toMatchObject({
      revision: 3,
      status: 'tombstoned',
      tombstoneReason: 'user requested deletion',
    })
    expect(await ctx.longTermMemory.search({ scope, query: 'lapsang', limit: 10 })).toEqual([])
    expect(await ctx.longTermMemory.read(scope, created.id)).toMatchObject({ status: 'tombstoned' })

    await ctx.fiber.dispose()
    const reopened = await harness(path)
    expect(await reopened.longTermMemory.read(scope, created.id)).toMatchObject({ revision: 3 })
    await reopened.fiber.dispose()
  })

  it('keeps candidates out of proactive recall and isolates every scope dimension', async () => {
    const ctx = await harness()
    const candidate = await ctx.longTermMemory.remember({
      scope,
      kind: 'fact',
      content: 'An unverified proposal about a blue deployment.',
      importance: 2,
      confidence: 0.5,
      trust: 'agent-proposed',
      status: 'candidate',
      evidence: [{
        sessionId: SessionId('session-a'),
        eventSeqs: [9],
        verification: 'agent-proposal',
        callId: CallId('call-proposed'),
      }],
    })
    expect(await ctx.longTermMemory.search({
      scope,
      query: 'blue deployment',
      limit: 10,
      statuses: ['candidate'],
    })).toHaveLength(1)
    const prepared = await ctx.longTermMemory.prepare({
      scope,
      sessionId: SessionId('session-next'),
      turn: 1,
      query: 'blue deployment',
      candidateLimit: 10,
    }, new AbortController().signal)
    expect(prepared.candidates).toEqual([])
    expect(await ctx.longTermMemory.read({ ...scope, userId: 'user-b' }, candidate.id)).toBeUndefined()
    expect(await ctx.longTermMemory.search({
      scope: { ...scope, workspaceId: '/workspace/b' },
      query: 'blue deployment',
      limit: 10,
      statuses: ['candidate'],
    })).toEqual([])
    await ctx.longTermMemory.commit({ prepared, recalledMemoryIds: [] })
    await ctx.fiber.dispose()
  })

  it('settles prepared turns idempotently and accounts only admitted recall', async () => {
    const ctx = await harness()
    const entry = await ctx.longTermMemory.remember({
      scope,
      kind: 'constraint',
      content: 'Use explicit file context for referenced files.',
      importance: 4,
      confidence: 1,
      trust: 'user-stated',
      status: 'active',
      evidence: [userEvidence],
    })
    const input = {
      scope,
      sessionId: SessionId('session-b'),
      turn: 1,
      query: 'file context',
      candidateLimit: 10,
    }
    const prepared = await ctx.longTermMemory.prepare(input, new AbortController().signal)
    const repeated = await ctx.longTermMemory.prepare(input, new AbortController().signal)
    expect(repeated).toEqual(prepared)
    await ctx.longTermMemory.commit({ prepared, recalledMemoryIds: [entry.id] })
    await ctx.longTermMemory.commit({ prepared, recalledMemoryIds: [entry.id] })
    expect(await ctx.longTermMemory.read(scope, entry.id)).toMatchObject({ accessCount: 1 })

    const aborted = await ctx.longTermMemory.prepare({ ...input, turn: 2 }, new AbortController().signal)
    await ctx.longTermMemory.abort({ prepared: aborted, reason: 'host-turn-error' })
    await ctx.longTermMemory.abort({ prepared: aborted, reason: 'host-turn-error' })
    expect(() => ctx.longTermMemory.commit({ prepared: aborted, recalledMemoryIds: [] })).toThrow('already aborted')
    await ctx.fiber.dispose()
  })

  it('rejects unsafe active writes, secrets, and invalid evidence', async () => {
    const ctx = await harness()
    expect(() => ctx.longTermMemory.remember({
      scope,
      kind: 'fact',
      content: 'Guessed deployment state',
      importance: 1,
      confidence: 0.5,
      trust: 'agent-proposed',
      status: 'active',
      evidence: [userEvidence],
    })).toThrow('active memory requires')
    expect(() => ctx.longTermMemory.remember({
      scope,
      kind: 'fact',
      content: 'api_key = abcdefghijklmnop',
      importance: 1,
      confidence: 1,
      trust: 'user-stated',
      status: 'active',
      evidence: [userEvidence],
    })).toThrow('secret')
    expect(() => ctx.longTermMemory.remember({
      scope,
      kind: 'fact',
      content: 'No evidence entry',
      importance: 1,
      confidence: 1,
      trust: 'user-stated',
      status: 'active',
      evidence: [],
    })).toThrow('durable evidence')
    expect(await ctx.longTermMemory.read(scope, MemoryId('missing'))).toBeUndefined()
    await ctx.fiber.dispose()

    const bounded = new Context()
    await bounded.plugin(SqliteLongTermMemory, { path: ':memory:', maxContentChars: 10, maxSummaryChars: 5 })
    expect(() => bounded.longTermMemory.remember({
      scope,
      kind: 'fact',
      content: 'eleven chars',
      importance: 1,
      confidence: 1,
      trust: 'user-stated',
      status: 'active',
      evidence: [userEvidence],
    })).toThrow('10 Unicode code points')
    await bounded.fiber.dispose()
  })
})
