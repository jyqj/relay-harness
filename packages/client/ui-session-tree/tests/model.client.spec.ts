import { describe, expect, it } from 'vitest'
import type { HistoryEntry, SessionEvent, SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionListState, SessionSummary, WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import {
  buildSessionTreeGraph, currentPathCuts, messageText, projectSessionTurns, sessionIdsForAnchor, visibleSessionTreeGraph,
} from '../src/client/model.ts'

const sid = (value: string): SessionId => value as SessionId
const event = (seq: number, type: SessionEvent['type'], data: unknown): HistoryEntry => ({
  event: { seq, time: seq, type, data } as SessionEvent,
})
const turn = (start: number, turnId: number, user: string, assistant: string, tool?: string): HistoryEntry[] => [
  event(start, 'turn/start', { turn: turnId }),
  event(start + 1, 'step/start', { turn: turnId, step: 1 }),
  event(start + 2, 'user/message', {
    id: `u-${start}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: user }],
  }),
  ...(tool === undefined ? [] : [event(start + 3, 'tool/call', {
    turn: turnId, step: 1, callId: `c-${start}`, name: tool, arguments: '{}',
  }), event(start + 4, 'tool/result', {
    turn: turnId,
    step: 1,
    message: {
      role: 'user', source: { kind: 'tool', callId: `c-${start}` },
      content: [{ type: 'tool-result', toolCallId: `c-${start}`, content: [{ type: 'text', text: 'ok' }] }],
    },
  })]),
  event(start + (tool === undefined ? 3 : 5), 'assistant/message', {
    turn: turnId,
    step: 1,
    message: {
      id: `a-${start}`, role: 'assistant', source: { kind: 'model', provider: 'test', model: 'test' },
      content: [{ type: 'text', text: assistant }],
    },
  }),
  event(start + (tool === undefined ? 4 : 6), 'step/end', { turn: turnId, step: 1 }),
  event(start + (tool === undefined ? 5 : 7), 'turn/end', { turn: turnId, reason: { kind: 'completed' } }),
]

function summary(id: string, input: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: sid(id), displayTitle: id, running: false, blank: false, updatedAt: 1, ...input,
  }
}

function sessions(rows: readonly SessionSummary[], current = rows[0]?.id): SessionListState {
  return {
    ids: rows.map(row => row.id),
    byId: Object.fromEntries(rows.map(row => [row.id, row])),
    current,
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  }
}

function workspaces(ids: readonly SessionId[], archivedSessionIds: readonly SessionId[] = []): WorkspaceListState {
  return {
    items: [{
      workspaceId: 'w' as never, title: 'W', path: '/w', sessionIds: [...ids],
      createdAt: '2026-08-21T00:00:00.000Z', updatedAt: '2026-08-21T00:00:00.000Z',
    }],
    archivedSessionIds,
    state: 'idle',
    phase: 'ready',
    error: null,
    baselinesReady: true,
    recentWorkspaceId: 'w' as never,
  }
}

describe('Session Tree projection', () => {
  it('flattens visible nested blocks and ignores non-content values', () => {
    expect(messageText(null)).toBe('')
    expect(messageText([
      null,
      { type: 'image', data: 'hidden' },
      { type: 'reasoning', text: 'reason' },
      { type: 'tool-result', content: [{ type: 'text', text: 'tool text' }] },
      { type: 'unknown', text: 'ignored' },
    ])).toBe('[图片]\nreason\ntool text')
  })

  it('projects only a fork child live tail and folds tool calls into its Turn', () => {
    const inherited = turn(0, 1, 'old', 'old answer')
    const live = turn(inherited.length, 2, 'new', 'new answer', 'bash')
    const child = summary('child', { parentId: sid('root'), seedLength: inherited.length })
    const turns = projectSessionTurns(child, [...inherited, ...live])
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({
      turn: 2,
      userText: ['new'],
      assistantText: ['new answer'],
      tools: [{ callId: `c-${inherited.length}`, name: 'bash', resultText: 'ok', isError: false }],
    })
  })

  it('handles context, empty/out-of-turn messages, open Turns, and mismatched close records', () => {
    const row = summary('root', { running: true })
    const events = [
      event(0, 'user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'outside' }] }),
      event(1, 'turn/start', { turn: 1 }),
      event(2, 'user/message', { role: 'user', source: { kind: 'plugin', plugin: 'x' }, content: [{ type: 'text', text: 'context' }] }),
      event(3, 'user/message', { role: 'user', source: { kind: 'user' }, content: [] }),
      event(4, 'assistant/message', {
        turn: 1, step: 1, message: { role: 'assistant', source: { kind: 'model' }, content: [] },
      }),
      event(5, 'turn/end', { turn: 2, reason: { kind: 'completed' } }),
      event(6, 'session/end-seed', {}),
      event(7, 'tool/result', {
        turn: 1, step: 1, error: { name: 'Error', code: 'FAILED' },
        message: {
          role: 'user', source: { kind: 'tool', callId: 'missing' },
          content: [{ type: 'tool-result', toolCallId: 'missing', content: [{ type: 'text', text: 'failed' }] }],
        },
      }),
    ]
    expect(projectSessionTurns(row, events)).toEqual([
      expect.objectContaining({
        turn: 1, contextText: ['context'], assistantText: [],
        tools: [{ callId: 'missing', name: 'tool', resultText: 'failed', isError: true }],
      }),
      expect.objectContaining({ turn: 2, endSeq: 5 }),
    ])
    const graph = buildSessionTreeGraph(sessions([row]), [row.id], { root: events }, {
      'session:root': { x: 9, y: 10 },
    })
    expect(graph.cards[0]).toMatchObject({ position: { x: 9, y: 10 } })
    expect(graph.cards.at(-1)?.running).toBe(true)
  })

  it('keeps workspace descendants, carries ancestors, and removes archived rows', () => {
    const root = summary('root')
    const child = summary('child', { parentId: root.id })
    const grandchild = summary('grandchild', { parentId: child.id, origin: 'subagent' })
    const other = summary('other', { cwd: '/other' })
    const state = sessions([root, child, grandchild, other], child.id)
    expect(sessionIdsForAnchor(state, workspaces([root.id], [child.id]), child.id))
      .toEqual([root.id, grandchild.id])
  })

  it('falls back to a cwd family when no Workspace accounts for the anchor', () => {
    const root = summary('root', { cwd: '/same' })
    const peer = summary('peer', { cwd: '/same' })
    const other = summary('other', { cwd: '/other' })
    expect(sessionIdsForAnchor(sessions([root, peer, other]), workspaces([]), root.id))
      .toEqual([root.id, peer.id])
  })

  it('resolves exact parent cuts for the current lineage and terminates cycles', () => {
    const root = summary('root')
    const child = summary('child', { parentId: root.id, seedLength: 9 })
    const leaf = summary('leaf', { parentId: child.id, seedLength: 17 })
    expect([...currentPathCuts(sessions([root, child, leaf], leaf.id))]).toEqual([
      [leaf.id, Number.POSITIVE_INFINITY], [child.id, 17], [root.id, 9],
    ])
    expect([...currentPathCuts({ ...sessions([root]), current: undefined })]).toEqual([])
    expect([...currentPathCuts({ ...sessions([root]), current: sid('missing') })]).toEqual([
      [sid('missing'), Number.POSITIVE_INFINITY],
    ])
    const uncutChild = summary('uncut', { parentId: root.id })
    expect([...currentPathCuts(sessions([root, uncutChild], uncutChild.id))]).toEqual([
      [uncutChild.id, Number.POSITIVE_INFINITY], [root.id, Number.POSITIVE_INFINITY],
    ])
    const a = summary('a', { parentId: sid('b'), seedLength: 2 })
    const b = summary('b', { parentId: a.id, seedLength: 3 })
    expect([...currentPathCuts(sessions([a, b], a.id))]).toEqual([
      [a.id, Number.POSITIVE_INFINITY], [b.id, 2],
    ])
  })

  it('connects a restored child to the exact parent Turn before seedLength', () => {
    const first = turn(0, 1, 'one', 'answer one')
    const second = turn(first.length, 2, 'two', 'answer two')
    const root = summary('root')
    const child = summary('child', { parentId: root.id, seedLength: first.length })
    const state = sessions([root, child])
    const graph = buildSessionTreeGraph(state, state.ids, {
      root: [...first, ...second],
      child: [...first, ...turn(first.length, 2, 'branch', 'branch answer')],
    })
    const rootFirst = graph.cards.find(card => card.sessionId === root.id && card.turn === 1)
    const childFirst = graph.cards.find(card => card.sessionId === child.id)
    expect(rootFirst).toBeDefined()
    expect(childFirst?.parentId).toBe(rootFirst?.id)
    expect(graph.edges).toContainEqual({ from: rootFirst?.id, to: childFirst?.id, branch: true })
  })

  it('uses latest and first-card fallbacks for children without a resolved cut', () => {
    const root = summary('root', { running: true })
    const latest = summary('latest', { parentId: root.id })
    const empty = summary('empty', { parentId: root.id, seedLength: 0, blank: true })
    const rootHistory = [
      event(0, 'turn/start', { turn: 1 }),
      event(1, 'user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'open' }] }),
    ]
    const graph = buildSessionTreeGraph(sessions([root, latest, empty]), [root.id, latest.id, empty.id], { root: rootHistory })
    const rootCard = graph.cards.find(card => card.sessionId === root.id)!
    expect(graph.cards.filter(card => card.sessionId !== root.id).map(card => card.parentId))
      .toEqual([rootCard.id, rootCard.id])
    expect(rootCard.running).toBe(true)
  })

  it('degrades cyclic lineage to visible roots instead of dropping sessions', () => {
    const a = summary('a', { parentId: sid('b') })
    const b = summary('b', { parentId: sid('a') })
    const graph = buildSessionTreeGraph(sessions([a, b]), [a.id, b.id], {})
    expect(graph.cards.map(card => card.sessionId)).toEqual([a.id, b.id])
    expect(graph.edges).toEqual([])
  })

  it('hides collapsed descendants and retains ancestor paths for labels and search', () => {
    const root = summary('root')
    const child = summary('child', { parentId: root.id, seedLength: 6 })
    const state = sessions([root, child])
    const complete = buildSessionTreeGraph(state, state.ids, {
      root: turn(0, 1, 'root question', 'root answer'),
      child: turn(6, 2, 'needle', 'answer', 'bash'),
    })
    const rootCard = complete.cards[0]!
    const childCard = complete.cards[1]!
    expect(visibleSessionTreeGraph(complete, {
      collapsed: { [rootCard.id]: true }, labels: {}, filterMode: 'default', query: '',
    }).cards.map(card => card.id)).toEqual([rootCard.id])
    expect(visibleSessionTreeGraph(complete, {
      collapsed: {}, labels: { [childCard.id]: 'keep' }, filterMode: 'labeled-only', query: '',
    }).cards.map(card => card.id)).toEqual([rootCard.id, childCard.id])
    expect(visibleSessionTreeGraph(complete, {
      collapsed: {}, labels: {}, filterMode: 'default', query: 'needle',
    }).cards.map(card => card.id)).toEqual([rootCard.id, childCard.id])
    expect(visibleSessionTreeGraph(complete, {
      collapsed: { [childCard.id]: true }, labels: {}, filterMode: 'default', query: '',
    }).cards.map(card => card.id)).toEqual([rootCard.id, childCard.id])
    expect(visibleSessionTreeGraph(complete, {
      collapsed: { [rootCard.id]: true, [childCard.id]: true }, labels: {}, filterMode: 'default', query: '',
    }).cards.map(card => card.id)).toEqual([rootCard.id])
    const contextOnly = {
      ...complete,
      cards: complete.cards.map(card => card.id === childCard.id ? { ...card, userText: '' } : card),
    }
    expect(visibleSessionTreeGraph(contextOnly, {
      collapsed: {}, labels: {}, filterMode: 'user-only', query: '',
    }).cards.map(card => card.id)).toEqual([rootCard.id])
  })
})
