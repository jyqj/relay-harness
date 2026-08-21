// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { HistoryEntry, SessionEvent, SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionListState, WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
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

const sessionState: SessionListState = {
  ids: [sid('root')],
  byId: {
    [sid('root')]: {
      id: sid('root'), displayTitle: 'Root', cwd: '/w', running: false, blank: false, updatedAt: 1,
    },
  },
  current: sid('root'),
  phase: 'ready',
  subagentsByParent: {},
  jobsBySession: {},
  currentAddress: undefined,
}
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

function mount() {
  const openSession = vi.fn()
  const forkSession = vi.fn(async () => sid('child'))
  const sendMessage = vi.fn(async () => {})
  const archiveSession = vi.fn(async () => {})
  const loadHistory = vi.fn(async () => history)
  const store = createSessionTreeStore().create()
  const t: SessionTreeCanvasProps['t'] = key => (en as Record<string, string>)[key] ?? key
  render(
    <SessionTreeCanvas
      useTreeOpen={selector => selector({ open: true, anchorSessionId: sid('root') })}
      useSessions={selector => selector(sessionState)}
      useWorkspaces={selector => selector(workspaceState)}
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
  return { openSession, forkSession, sendMessage, archiveSession, loadHistory, store }
}

describe('SessionTreeCanvas', () => {
  it('loads durable history, renders a Turn card, opens its Session, and forks at turn/end', async () => {
    const b = mount()
    expect(screen.getByRole('dialog', { name: 'Session Tree' })).toBeTruthy()
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
})
