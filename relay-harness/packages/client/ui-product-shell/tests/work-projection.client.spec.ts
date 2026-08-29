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
      jobs: { total: 3, running: 2 },
      trajectoryRecords: 3,
      deliverables: ['a.md', 'b.ts'],
      approvals: 1,
      questions: 1,
      completion: 'running',
      cwd: '/work',
    })
    projection.dispose()
    expect(listListeners.size).toBe(0)
    expect(sessionListeners.size).toBe(0)
  })
})
