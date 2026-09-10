import { connectionFixture } from './connection-fixture.client.ts'
import { describe, expect, it } from 'vitest'
import type { ConversationSnapshot, ISessions } from '@relay-harness/rlh-client-runtime/client'
import { CurrentWorkProjection } from '../src/client/work-projection.ts'

function harness() {
  const listListeners = new Set<() => void>()
  const sessionListeners = new Set<() => void>()
  const snapshot = { openState: 'open' as ConversationSnapshot['openState'], removed: false, running: false, pending: [] as { kind: 'approval' | 'question' }[], views: { get: () => undefined } }
  const state = {
    current: 's1' as string | undefined,
    byId: { s1: { cwd: '/one', projectionValues: {
      goal: null as { goal: { objective: string; phase: string } } | null,
      workAcceptance: { reviewRevision: 8, acceptedRevision: null as number | null, reviewable: true },
      deliverables: { paths: ['out.md'], unindexedResults: 0 },
    } } },
    jobsBySession: { s1: [] as { status: string }[] },
  }
  let loaded = true
  const session = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { sessionListeners.add(listener); return () => { sessionListeners.delete(listener) } },
  }
  const sessions = {
    list: {
      getSnapshot: () => state,
      subscribe: (listener: () => void) => { listListeners.add(listener); return () => { listListeners.delete(listener) } },
    },
    binding: (id: string) => loaded && id === 's1' ? { session } : undefined,
  } as unknown as ISessions
  const connection = connectionFixture()
  const projection = new CurrentWorkProjection(sessions, connection.source)
  const publishList = () => { for (const listener of listListeners) listener() }
  return { projection, connection, state, snapshot, sessionListeners, listListeners, publishList,
    setLoaded: (value: boolean) => { loaded = value; publishList() } }
}

describe('independent Work facts', () => {
  it('allows an ordinary idle result to be reviewed without inventing a Goal', () => {
    const h = harness()
    const work = h.projection.getSnapshot()
    expect(work.goal).toBeNull()
    expect(work.execution).toBe('idle')
    expect(work.acceptance).toEqual({ reviewRevision: 8, acceptedRevision: null, reviewable: true })
    h.projection.dispose()
  })

  it.each(['paused', 'blocked', 'complete'] as const)('preserves a %s Goal while a background job runs', (phase) => {
    const h = harness()
    h.state.byId.s1.projectionValues.goal = { goal: { objective: 'Ship', phase } }
    h.state.jobsBySession.s1 = [{ status: 'running' }, { status: 'failed' }]
    h.publishList()
    expect(h.projection.getSnapshot().execution).toBe('running')
    expect(h.projection.getSnapshot().goal?.phase).toBe(phase)
    expect(h.projection.getSnapshot().jobs).toEqual({ total: 2, running: 1, failed: 1, killed: 0 })
    expect(h.projection.getSnapshot().acceptance).toBeNull()
    h.projection.dispose()
  })

  it('keeps approvals and questions independently visible while execution is idle', () => {
    const h = harness()
    h.snapshot.pending = [{ kind: 'approval' }, { kind: 'question' }, { kind: 'question' }]
    for (const listener of h.sessionListeners) listener()
    expect(h.projection.getSnapshot().execution).toBe('idle')
    expect(h.projection.getSnapshot().approvals).toBe(1)
    expect(h.projection.getSnapshot().questions).toBe(2)
    h.projection.dispose()
  })

  it('publishes an outcome change even when total and running job counts are unchanged', () => {
    const h = harness()
    h.state.jobsBySession.s1 = [{ status: 'failed' }]
    h.publishList()
    const before = h.projection.getSnapshot()
    let notifications = 0
    const off = h.projection.subscribe(() => { notifications += 1 })
    h.state.jobsBySession.s1 = [{ status: 'killed' }]
    h.publishList()
    expect(h.projection.getSnapshot().jobs).toEqual({ total: 1, running: 0, failed: 0, killed: 1 })
    expect(h.projection.getSnapshot() === before).toBe(false)
    expect(notifications).toBe(1)
    h.state.jobsBySession.s1 = [{ status: 'killed' }]
    h.publishList()
    expect(notifications).toBe(1)
    off()
    h.projection.dispose()
  })

  it('distinguishes missing execution data from idle and withdraws review until rebound', () => {
    const h = harness()
    h.setLoaded(false)
    expect(h.projection.getSnapshot().execution).toBe('unknown')
    expect(h.projection.getSnapshot().acceptance).toBeNull()
    expect(h.sessionListeners.size).toBe(0)
    h.setLoaded(true)
    expect(h.projection.getSnapshot().execution).toBe('idle')
    expect(h.projection.getSnapshot().acceptance?.reviewRevision).toBe(8)
    expect(h.sessionListeners.size).toBe(1)
    h.projection.dispose()
  })

  it('retains job records without claiming live execution before history loads', () => {
    const h = harness()
    h.state.jobsBySession.s1 = [{ status: 'stopping' }]
    h.setLoaded(false)
    expect(h.projection.getSnapshot().execution).toBe('unknown')
    expect(h.projection.getSnapshot().jobs.running).toBe(1)
    expect(h.projection.getSnapshot().acceptance).toBeNull()
    h.projection.dispose()
  })

  it('does not carry the previous Session workspace, outcomes, or review into another Session', () => {
    const h = harness()
    h.state.jobsBySession.s1 = [{ status: 'failed' }]
    h.publishList()
    h.state.current = 's2'
    h.publishList()
    const work = h.projection.getSnapshot()
    expect(work.sessionId).toBe('s2')
    expect(work.cwd).toBe(undefined)
    expect(work.execution).toBe('unknown')
    expect(work.jobs).toEqual({ total: 0, running: 0, failed: 0, killed: 0 })
    expect(work.deliverables).toEqual([])
    expect(work.acceptance).toBeNull()
    expect(h.sessionListeners.size).toBe(0)
    h.state.current = undefined
    h.publishList()
    expect(h.projection.getSnapshot().sessionId).toBe(undefined)
    h.projection.dispose()
    expect(h.listListeners.size).toBe(0)
  })
})


describe('Work connection and history lifetimes', () => {
  it('withdraws review on disconnect and republishes the same log revision with a new handshake identity', () => {
    const h = harness()
    h.connection.publish('reconnecting')
    expect(h.projection.getSnapshot()).toMatchObject({ epoch: 1, availability: 'disconnected', execution: 'unknown', acceptance: null })
    expect(h.projection.getSnapshot().deliverables).toEqual(['out.md'])
    h.connection.publish('synchronizing', 2)
    expect(h.projection.getSnapshot().availability).toBe('synchronizing')
    expect(h.projection.getSnapshot().acceptance).toBeNull()
    h.connection.publish('ready')
    expect(h.projection.getSnapshot()).toMatchObject({ epoch: 2, availability: 'ready', execution: 'idle' })
    expect(h.projection.getSnapshot().acceptance?.reviewRevision).toBe(8)
    h.projection.dispose()
    expect(h.connection.listeners.size).toBe(0)
    const last = h.projection.getSnapshot()
    h.connection.publish('reconnecting')
    expect(h.projection.getSnapshot()).toBe(last)
  })

  it.each(['cold', 'loading', 'error'] as const)('does not call a %s history idle despite a live binding', (openState) => {
    const h = harness()
    h.snapshot.openState = openState
    h.publishList()
    expect(h.projection.getSnapshot().execution).toBe('unknown')
    expect(h.projection.getSnapshot().acceptance).toBeNull()
    expect(h.projection.getSnapshot().availability).toBe(openState === 'error' ? 'error' : 'loading')
    h.snapshot.openState = 'open'
    h.publishList()
    expect(h.projection.getSnapshot().acceptance?.reviewRevision).toBe(8)
    h.projection.dispose()
  })

  it('withdraws review for a removed Session without discarding its last read outputs', () => {
    const h = harness()
    h.snapshot.removed = true
    h.publishList()
    expect(h.projection.getSnapshot().availability).toBe('removed')
    expect(h.projection.getSnapshot().acceptance).toBeNull()
    expect(h.projection.getSnapshot().deliverables).toEqual(['out.md'])
    h.projection.dispose()
  })
})
