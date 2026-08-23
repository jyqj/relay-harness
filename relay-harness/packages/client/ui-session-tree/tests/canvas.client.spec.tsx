// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { HistoryEntry, SessionEvent, SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionListState, SessionSummary, WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import { SessionTreeCanvas, type SessionTreeCanvasProps } from '../src/client/SessionTreeCanvas.tsx'
import { createSessionTreeStore } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const sid = (value: string): SessionId => value as SessionId
const history: HistoryEntry[] = [
  { event: { seq: 0, time: 0, type: 'turn/start', data: { turn: 1 } } },
  { event: { seq: 1, time: 1, type: 'step/start', data: { turn: 1, step: 1 } } },
  { event: { seq: 2, time: 2, type: 'user/message', data: {
    id: 'u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'question' }],
  } } as SessionEvent },
  { event: { seq: 3, time: 3, type: 'assistant/message', data: {
    turn: 1, step: 1, message: {
      id: 'a', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'answer' }],
    },
  } } as SessionEvent },
  { event: { seq: 4, time: 4, type: 'step/end', data: { turn: 1, step: 1 } } },
  { event: { seq: 5, time: 5, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } },
]

function sessionState(rows: readonly SessionSummary[]): SessionListState {
  return {
    ids: rows.map(row => row.id),
    byId: Object.fromEntries(rows.map(row => [row.id, row])),
    current: rows[0]?.id,
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  }
}
function summary(id: string, input: Partial<SessionSummary> = {}): SessionSummary {
  return { id: sid(id), displayTitle: id, cwd: '/w', running: false, blank: false, updatedAt: 1, ...input }
}
const oneSession = sessionState([summary('root', { displayTitle: 'Root' })])
const workspaceState: WorkspaceListState = {
  items: [{
    workspaceId: 'w' as never, title: 'W', path: '/w', sessionIds: [sid('root')],
    createdAt: '2026-08-21T00:00:00.000Z', updatedAt: '2026-08-21T00:00:00.000Z',
  }],
  archivedSessionIds: [],
  state: 'idle',
  phase: 'ready',
  error: null,
  baselinesReady: true,
  recentWorkspaceId: 'w' as never,
}

function bindStore(instance: ReturnType<ReturnType<typeof createSessionTreeStore>['create']>) {
  return {
    useStore: <S,>(selector: (state: ReturnType<typeof instance.getSnapshot>) => S) => selector(useSyncExternalStore(
      listener => instance.subscribe(listener), () => instance.getSnapshot(), () => instance.getSnapshot(),
    )),
    actions: instance.actions,
  }
}

interface MountOptions {
  open?: boolean
  sessions?: SessionListState
  workspaceSessionIds?: SessionId[]
  loadHistory?: SessionTreeCanvasProps['loadHistory']
}

function mount(options: MountOptions = {}) {
  const open = options.open ?? true
  const sessions = options.sessions ?? oneSession
  const workspace = options.workspaceSessionIds === undefined ? workspaceState : {
    ...workspaceState,
    items: [{
      ...workspaceState.items[0]!,
      sessionIds: [...options.workspaceSessionIds],
    }],
  }
  const openSession = vi.fn()
  const forkSession = vi.fn(async () => sid('child'))
  const sendMessage = vi.fn(async () => {})
  const archiveSession = vi.fn(async () => {})
  const loadHistory = options.loadHistory ?? vi.fn(async () => history)
  const store = createSessionTreeStore().create()
  const t: SessionTreeCanvasProps['t'] = key => (en as Record<string, string>)[key] ?? key
  const view = render(
    <SessionTreeCanvas
      useTreeOpen={selector => selector(
        sessions.current === undefined ? { open } : { open, anchorSessionId: sessions.current },
      )}
      useSessions={selector => selector(sessions)}
      useWorkspaces={selector => selector(workspace)}
      {...bindStore(store)}
      closeTree={vi.fn()}
      loadHistory={loadHistory}
      openSession={openSession}
      forkSession={forkSession}
      sendMessage={sendMessage}
      startSession={vi.fn()}
      archiveSession={archiveSession}
      t={t}
    />,
  )
  return { view, openSession, forkSession, sendMessage, archiveSession, loadHistory, store }
}

describe('SessionTreeCanvas', () => {
  it('renders workspace structure from list metadata without fetching any history', () => {
    const b = mount()
    expect(screen.getByRole('dialog', { name: 'Session Tree' })).toBeTruthy()
    // The Session stub card exists (title + turn placeholder) before any read.
    expect(screen.getByRole('button', { name: 'Root' })).toBeTruthy()
    expect(screen.getByText('Turn —')).toBeTruthy()
    expect(b.loadHistory).not.toHaveBeenCalled()
  })

  it('loads one Session history when its card is selected, renders the Turn, and forks at turn/end', async () => {
    const b = mount()
    fireEvent.click(screen.getByText('Turn —'))
    expect(b.loadHistory).toHaveBeenCalledTimes(1)
    expect(b.loadHistory).toHaveBeenCalledWith('root', expect.any(AbortSignal))
    await screen.findByText('question')
    expect(screen.getByText('answer')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Root' }))
    expect(b.openSession).toHaveBeenCalledWith('root')
    fireEvent.click(screen.getAllByRole('button', { name: 'Fork here' })[0]!)
    await waitFor(() => {
      expect(b.forkSession).toHaveBeenCalledWith({ sessionId: 'root', atSeq: 5 })
      expect(b.openSession).toHaveBeenCalledWith('child')
    })
  })

  it('persists labels and exposes the rewrite flow after selecting a question card', async () => {
    const b = mount()
    fireEvent.click(screen.getByText('Turn —'))
    const question = await screen.findByText('question')
    fireEvent.click(question)
    const label = screen.getByLabelText('Label')
    fireEvent.change(label, { target: { value: 'checkpoint' } })
    expect(b.store.getSnapshot().labels).toEqual({ 'session:root': 'checkpoint' })
    fireEvent.click(screen.getByRole('button', { name: 'Rewrite this question' }))
    await waitFor(() => {
      expect(b.forkSession).toHaveBeenCalledWith({ sessionId: 'root', beforeSeq: 0 })
      expect(b.sendMessage).toHaveBeenCalledWith('child', 'question')
    })
  })

  it('bounds concurrent history fetches and drains the queue as loads settle', async () => {
    const settle: Array<() => void> = []
    const loadHistory = vi.fn((_sessionId: SessionId, _signal?: AbortSignal) =>
      new Promise<HistoryEntry[]>((resolve) => {
        settle.push(() => { resolve(history) })
      }))
    const rows = Array.from({ length: 6 }, (_value, index) => summary(`s${index}`))
    mount({
      sessions: sessionState(rows),
      workspaceSessionIds: rows.map(row => row.id),
      loadHistory,
    })
    for (const stub of screen.getAllByText('Turn —')) fireEvent.click(stub)
    // Six selected Sessions, four in flight; the rest wait in the queue.
    expect(loadHistory).toHaveBeenCalledTimes(4)
    await act(async () => { settle[0]!() })
    await waitFor(() => { expect(loadHistory).toHaveBeenCalledTimes(5) })
    await act(async () => { for (const resolve of settle.slice(1)) resolve() })
    await waitFor(() => { expect(loadHistory).toHaveBeenCalledTimes(6) })
    await screen.findAllByText('question')
  })

  it('aborts the in-flight history read when the overlay closes', async () => {
    const signals: AbortSignal[] = []
    const loadHistory = vi.fn((_sessionId: SessionId, signal?: AbortSignal) => new Promise<HistoryEntry[]>(
      (_resolve, reject) => {
        signals.push(signal ?? new AbortController().signal)
        signal?.addEventListener('abort', () => { reject(new Error('aborted')) })
      },
    ))
    const rows = Array.from({ length: 2 }, (_value, index) => summary(`s${index}`))
    const sessions = sessionState(rows)
    const b = mount({
      open: false,
      sessions,
      workspaceSessionIds: rows.map(row => row.id),
      loadHistory,
    })
    expect(screen.queryByRole('dialog')).toBeNull()
    // Opening the tree and selecting a card starts a cancellable read.
    b.view.rerender(
      <SessionTreeCanvas
        useTreeOpen={selector => selector(
          sessions.current === undefined ? { open: true } : { open: true, anchorSessionId: sessions.current },
        )}
        useSessions={selector => selector(sessions)}
        useWorkspaces={selector => selector({
          ...workspaceState,
          items: [{ ...workspaceState.items[0]!, sessionIds: [...rows.map(row => row.id)] }],
        })}
        {...bindStore(b.store)}
        closeTree={vi.fn()}
        loadHistory={loadHistory}
        openSession={vi.fn()}
        forkSession={vi.fn(async () => sid('child'))}
        sendMessage={vi.fn(async () => {})}
        startSession={vi.fn()}
        archiveSession={vi.fn(async () => {})}
        t={key => (en as Record<string, string>)[key] ?? key}
      />,
    )
    fireEvent.click(screen.getAllByText('Turn —')[0]!)
    expect(loadHistory).toHaveBeenCalledTimes(1)
    await act(async () => { b.view.rerender(
      <SessionTreeCanvas
        useTreeOpen={selector => selector(
          sessions.current === undefined ? { open: false } : { open: false, anchorSessionId: sessions.current },
        )}
        useSessions={selector => selector(sessions)}
        useWorkspaces={selector => selector({
          ...workspaceState,
          items: [{ ...workspaceState.items[0]!, sessionIds: [...rows.map(row => row.id)] }],
        })}
        {...bindStore(b.store)}
        closeTree={vi.fn()}
        loadHistory={loadHistory}
        openSession={vi.fn()}
        forkSession={vi.fn(async () => sid('child'))}
        sendMessage={vi.fn(async () => {})}
        startSession={vi.fn()}
        archiveSession={vi.fn(async () => {})}
        t={key => (en as Record<string, string>)[key] ?? key}
      />,
    ) })
    expect(signals[0]!.aborted).toBe(true)
  })
})
