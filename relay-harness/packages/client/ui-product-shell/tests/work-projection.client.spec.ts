import { describe, expect, it } from 'vitest'
import type { ISessions } from '@relay-harness/rlh-client-runtime/client'
import { CurrentWorkProjection } from '../src/client/work-projection.ts'

describe('CurrentWorkProjection', () => {
  it('derives Goal, Plan, Jobs, Trajectory, Deliverables, and Approvals from current Session facts', () => {
    const listListeners = new Set<() => void>()
    const sessionListeners = new Set<() => void>()
    const sessionId = 'session-1'
    const snapshot = {
      views: { get: (key: string) => key === 'trajectory' ? { eventNodes: [{}, {}, {}] } : undefined },
      chat: { timeline: { turns: new Map([[1, { data: new Map([['deliverables', { produced: [
        { path: 'a.md' }, { path: 'a.md' }, { path: 'b.ts' },
      ] }]]) }]]) } },
      pending: [{ kind: 'approval' }, { kind: 'question' }],
      running: true,
    }
    const session = {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => { sessionListeners.add(listener); return () => { sessionListeners.delete(listener) } },
    }
    const listState = {
      current: sessionId,
      byId: { [sessionId]: { cwd: '/work', projectionValues: {
        goal: { goal: { objective: 'Deliver product shell', phase: 'active' } },
        plan: { active: true, pending: false },
        deliverables: { paths: ['a.md', 'b.ts'], unindexedResults: 0 },
      } } },
      jobsBySession: { [sessionId]: [
        { status: 'running' }, { status: 'completed' }, { status: 'stopping' },
      ] },
    }
    const sessions = {
      list: {
        getSnapshot: () => listState,
        subscribe: (listener: () => void) => { listListeners.add(listener); return () => { listListeners.delete(listener) } },
      },
      binding: () => ({ session }),
    } as unknown as ISessions
    const projection = new CurrentWorkProjection(sessions)
    expect(projection.getSnapshot()).toEqual({
      sessionId,
      goal: { objective: 'Deliver product shell', phase: 'active' },
      plan: { active: true, pending: false },
      jobs: { total: 3, running: 2, failed: 0, killed: 0 },
      trajectoryRecords: 3,
      deliverables: ['a.md', 'b.ts'],
      unindexedResults: 0,
      acceptance: null,
      approvals: 1,
      questions: 1,
      execution: 'running',
      cwd: '/work',
    })
    projection.dispose()
    expect(listListeners.size).toBe(0)
    expect(sessionListeners.size).toBe(0)
  })
})

function workHarness(phase: string, running = false, jobStatus?: string) {
  const listListeners = new Set<() => void>()
  const sessionListeners = new Set<() => void>()
  const snapshot = {
    views: { get: () => undefined }, pending: [], running,
    get chat(): never { throw new Error('Work must not scan the paged chat timeline') },
  }
  const state = {
    current: 's1',
    byId: { s1: { cwd: '/work', projectionValues: {
      goal: { goal: { objective: 'Ship', phase } },
      deliverables: { paths: ['older-than-page.md'], unindexedResults: 0 },
    } } },
    jobsBySession: { s1: jobStatus === undefined ? [] : [{ status: jobStatus }] },
  }
  const session = {
    getSnapshot: () => snapshot,
    subscribe: (fn: () => void) => { sessionListeners.add(fn); return () => { sessionListeners.delete(fn) } },
  }
  const sessions = {
    list: { getSnapshot: () => state, subscribe: (fn: () => void) => { listListeners.add(fn); return () => { listListeners.delete(fn) } } },
    binding: () => ({ session }),
  } as unknown as ISessions
  return { projection: new CurrentWorkProjection(sessions), snapshot, state, sessionListeners, listListeners }
}

describe('Work fact invalidation', () => {
  it.each([
    ['paused', false, undefined, 'idle'], ['blocked', false, undefined, 'idle'],
    ['complete', true, undefined, 'running'], ['complete', false, 'running', 'running'],
    ['complete', false, 'stopping', 'running'], ['complete', false, undefined, 'idle'], ['paused', false, 'running', 'running'],
  ] as const)('derives %s with running=%s and job=%s as %s', (phase, running, jobStatus, expected) => {
    const { projection } = workHarness(phase, running, jobStatus)
    expect(projection.getSnapshot().execution).toBe(expected)
    expect(projection.getSnapshot().goal?.phase).toBe(phase)
    expect(projection.getSnapshot().deliverables).toEqual(['older-than-page.md'])
    projection.dispose()
  })

  it('does not publish when streams or equivalent carrier snapshots change no Work facts', () => {
    const { projection, state, snapshot, sessionListeners, listListeners } = workHarness('active', true)
    const original = projection.getSnapshot()
    let calls = 0
    projection.subscribe(() => { calls++ })
    for (let i = 0; i < 100; i++) for (const fn of sessionListeners) fn()
    state.byId.s1.projectionValues.deliverables = { paths: ['older-than-page.md'], unindexedResults: 0 }
    for (const fn of listListeners) fn()
    expect(projection.getSnapshot()).toBe(original)
    expect(calls).toBe(0)
    snapshot.running = false
    for (const fn of sessionListeners) fn()
    expect(projection.getSnapshot().execution).toBe('idle')
    expect(calls).toBe(1)
    projection.dispose()
  })
})

it('does not publish streaming review-sequence changes while Work is busy', () => {
  const { projection, state, snapshot, sessionListeners } = workHarness('active', true)
  const initial = projection.getSnapshot()
  let notifications = 0
  projection.subscribe(() => { notifications += 1 })
  for (let reviewRevision = 1; reviewRevision <= 100; reviewRevision += 1) {
    Object.assign(state.byId.s1.projectionValues, {
      workAcceptance: { reviewRevision, acceptedRevision: 0, reviewable: false },
    })
    for (const listener of sessionListeners) listener()
  }
  expect(notifications).toBe(0)
  expect(projection.getSnapshot()).toBe(initial)
  snapshot.running = false
  Object.assign(state.byId.s1.projectionValues, {
    workAcceptance: { reviewRevision: 101, acceptedRevision: 0, reviewable: true },
  })
  for (const listener of sessionListeners) listener()
  expect(notifications).toBe(1)
  expect(projection.getSnapshot().acceptance?.reviewRevision).toBe(101)
  projection.dispose()
})
