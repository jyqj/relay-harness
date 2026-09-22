// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@relay-harness/rlh-session/types'
import type { WorkView, WorkHistoryPage } from '@relay-harness/rlh-host-work-results/types'
import { RecordPage, type RecordPageProps } from '../src/client/RecordPage.tsx'
import type { ProductRoute } from '../src/client/navigation.ts'

afterEach(cleanup)
const id = SessionId('source-one')
function view(sessionId = id): WorkView {
  return {
    sessionId, relation: 'root', source: { throughSeq: 3, resident: false, current: false }, goal: null,
    execution: { activity: 'unknown', entries: [{ id: sessionId, sessionId, kind: 'agent', label: 'Saved source', activity: 'inactive', recovery: 'explicit-resume', relationship: { kind: 'owned', controlLink: false }, recoveryCapabilities: { history: 'persisted', resume: 'explicit', control: 'none' } }], omitted: 0 },
    attention: { approvals: 0, questions: 0, available: false }, outputs: { paths: [], unindexedResults: 0 },
    review: { reviewRevision: 3, acceptedRevision: null, reviewable: true },
    actions: { confirmRecord: { allowed: false, blockers: ['runtime-unavailable'], scope: 'session-log' } },
    capabilities: { contextAvailable: false, activationRequired: true, contextSources: [] },
    coverage: { missing: ['runtime-not-resident'], scope: 'observed-session-and-descendants' },
  }
}
function history(sessionId = id): WorkHistoryPage {
  return { sessionId, throughSeq: 3, snapshot: { throughSeq: 3, digest: 'observed-prefix' }, rows: [{ seq: 3, kind: 'assistant', text: 'Saved answer', truncated: false }], nextBeforeSeq: 3, scope: 'text-messages-only' }
}
function fixture() {
  const state = { route: { page: 'record', sessionId: id } as ProductRoute, connection: { phase: 'ready', epoch: 1 } }
  const inspect = vi.fn().mockImplementation((sessionId: typeof id) => Promise.resolve(view(sessionId)))
  const read = vi.fn().mockImplementation((request: { sessionId: typeof id }) => Promise.resolve(history(request.sessionId)))
  const props = {
    active: true, renderSlot: () => null, useSessions: () => undefined, useWorkspaces: () => undefined,
    useRoute: (select: (value: ProductRoute) => unknown) => select(state.route),
    useConnection: (select: (value: typeof state.connection) => unknown) => select(state.connection),
    inspect, history: read, openRecord: vi.fn(), openConversation: vi.fn(), t: (key: string) => key,
  } as unknown as RecordPageProps
  return { state, props, inspect, read }
}

describe('passive record page', () => {
  it('reads a cold source and navigates to execution only after the explicit action', async () => {
    const { props, inspect } = fixture()
    render(<RecordPage {...props} />)
    expect(await screen.findByText('Saved answer')).toBeTruthy()
    expect(screen.getByText(/· owned ·/).textContent).toContain('resume explicit')
    expect(inspect).toHaveBeenCalledWith(id, expect.any(AbortSignal))
    expect(props.openConversation).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'work.openConversation' }))
    expect(props.openConversation).toHaveBeenCalledWith(id)
  })

  it('renders execution entries without relationship or recovery facts as plain rows', async () => {
    const { props } = fixture()
    const bare = view()
    props.inspect = vi.fn().mockResolvedValue({
      ...bare,
      execution: { ...bare.execution, entries: [
        { id: 'child', sessionId: SessionId('child-one'), kind: 'subagent', label: 'Child one', activity: 'inactive', recovery: 'history-only' },
      ] },
    } satisfies WorkView)
    render(<RecordPage {...props} />)
    const row = (await screen.findByText(/Child one/)).closest('li')
    expect(row?.textContent).toContain('subagent')
    expect(row?.textContent).not.toContain('owned')
    expect(row?.textContent).not.toContain('resume')
  })
  it('binds older pages to the original observed prefix', async () => {
    const { props, read } = fixture()
    read.mockResolvedValueOnce(history()).mockResolvedValueOnce({ ...history(), rows: [{ seq: 1, kind: 'user', text: 'Earlier input', truncated: false }], nextBeforeSeq: null })
    render(<RecordPage {...props} />)
    await screen.findByText('Saved answer')
    fireEvent.click(screen.getByRole('button', { name: 'record.more' }))
    expect(await screen.findByText('Earlier input')).toBeTruthy()
    expect(read).toHaveBeenLastCalledWith({ sessionId: id, beforeSeq: 3, snapshot: history().snapshot }, expect.any(AbortSignal))
    expect(screen.queryByRole('button', { name: 'record.more' })).toBeNull()
  })
  it('ignores a late old-source response and aborts reads when hidden', async () => {
    const { props, state, inspect } = fixture()
    const delayed = Promise.withResolvers<WorkView>()
    inspect.mockReturnValueOnce(delayed.promise)
    const rendered = render(<RecordPage {...props} />)
    const oldSignal = inspect.mock.calls[0]?.[1] as AbortSignal
    state.route = { page: 'record', sessionId: SessionId('source-two') }
    rendered.rerender(<RecordPage {...props} />)
    await screen.findByText('Saved answer')
    await act(async () => { delayed.resolve({ ...view(), cwd: '/old' }); await delayed.promise })
    expect(oldSignal.aborted).toBe(true)
    expect(screen.queryByRole('heading', { name: 'source-one' })).toBeNull()
    rendered.rerender(<RecordPage {...props} active={false} />)
    await waitFor(() => { expect(screen.queryByText('Saved answer')).toBeNull() })
    expect((inspect.mock.calls.at(-1)?.[1] as AbortSignal).aborted).toBe(true)
  })
  it('does not read or select another Session for an invalid route or disconnected generation', async () => {
    const { props, state, inspect } = fixture()
    state.route = { page: 'record', error: 'invalid-route' }
    const rendered = render(<RecordPage {...props} />)
    expect(inspect).not.toHaveBeenCalled()
    state.route = { page: 'record', sessionId: id }
    state.connection = { phase: 'reconnecting', epoch: 2 }
    rendered.rerender(<RecordPage {...props} />)
    expect(inspect).not.toHaveBeenCalled()
    expect(props.openConversation).not.toHaveBeenCalled()
  })
  it('marks loaded facts stale and read-only across a disconnect and re-reads on the next epoch', async () => {
    const { props, state, inspect } = fixture()
    const rendered = render(<RecordPage {...props} />)
    await screen.findByText('Saved answer')
    state.connection = { phase: 'reconnecting', epoch: 1 }
    rendered.rerender(<RecordPage {...props} />)
    expect(screen.getByRole('status').textContent).toBe('work.staleFacts')
    expect(screen.getByRole('button', { name: 'record.refresh' }).hasAttribute('disabled')).toBe(true)
    await waitFor(() => { expect(screen.queryByText('Saved answer')).toBeNull() })
    expect(inspect).toHaveBeenCalledTimes(1)
    state.connection = { phase: 'ready', epoch: 2 }
    rendered.rerender(<RecordPage {...props} />)
    expect(await screen.findByText('Saved answer')).toBeTruthy()
    expect(inspect).toHaveBeenCalledTimes(2)
  })
  it('renders a failed history page and retries only a read', async () => {
    const { props, read } = fixture()
    read.mockRejectedValueOnce(new Error('source unreadable'))
    render(<RecordPage {...props} />)
    expect((await screen.findByRole('alert')).textContent).toContain('source unreadable')
    fireEvent.click(screen.getByRole('button', { name: 'record.refresh' }))
    expect(await screen.findByText('Saved answer')).toBeTruthy()
    expect(props.openConversation).not.toHaveBeenCalled()
  })
})
