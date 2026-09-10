// @vitest-environment jsdom
import { cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react'
import { afterEach,describe,expect,it,vi } from 'vitest'

import { LibraryPage,type LibraryPageProps } from '../src/client/LibraryPage.tsx'
import { WorkPage,type WorkPageProps } from '../src/client/WorkPage.tsx'
import type { WorkSummary } from '../src/client/work-projection.ts'

afterEach(cleanup)
const t = ((key: string) => key) as never
const unused = (() => undefined) as never

describe('product navigation pages', () => {
  it('Library uses Files and Settings selection callbacks rather than local placeholders', () => {
    const openFiles = vi.fn()
    const openSettings = vi.fn()
    const page = {
      wide: true,
      expandSidebar: vi.fn(),
      useSessions: ((select: (value: unknown) => unknown) => select({ current: 's1' })) as never,
      useWorkspaces: unused,
      openFiles,
      openSettings,
      queryLibrary: vi.fn().mockResolvedValue({
        entries: [], scannedSessions: 0, totalSessions: 0, unindexedResults: 0, unavailableSessions: 0, next: null,
      }),
      openLibraryOutput: vi.fn(),
      t,
    } as unknown as LibraryPageProps
    render(<LibraryPage {...page} />)
    fireEvent.click(screen.getByRole('button', { name: 'library.files' }))
    fireEvent.click(screen.getByRole('button', { name: 'library.memory' }))
    fireEvent.click(screen.getByRole('button', { name: 'library.index' }))
    expect(openFiles).toHaveBeenCalledOnce()
    expect(openSettings.mock.calls).toEqual([['memory'], ['code-index']])
  })

  it('Work renders every composed projection family from one live summary', async () => {
    const openDeliverable = vi.fn().mockResolvedValue(undefined)
    const summary: WorkSummary = {
      sessionId: 's1',
      goal: { objective: 'Ship', phase: 'active' },
      plan: { active: true, pending: false },
      jobs: { total: 2, running: 1, failed: 0, killed: 0 },
      trajectoryRecords: 8,
      deliverables: ['out.md'],
      unindexedResults: 0,
      acceptance: null,
      approvals: 1,
      questions: 2,
      execution: 'running',
      cwd: '/work',
    }
    const page = {
      wide: true,
      expandSidebar: vi.fn(),
      useSessions: unused,
      useWorkspaces: unused,
      useWork: (select: (value: WorkSummary) => unknown) => select(summary),
      openDeliverable,
      openFiles: vi.fn(),
      t,
    } as unknown as WorkPageProps
    render(<WorkPage {...page} />)
    expect(screen.getByText('Ship')).toBeTruthy()
    expect(screen.getByText('work.execution.running')).toBeTruthy()
    expect(screen.getByText('1/2')).toBeTruthy()
    expect(screen.getByText('8')).toBeTruthy()
    expect(screen.getAllByText('1')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'out.md' }))
    expect(openDeliverable).toHaveBeenCalledWith('s1', 'out.md')
    await waitFor(() => { expect(screen.getByRole('button', { name: 'out.md' }).hasAttribute('disabled')).toBe(false) })
  })
})

function workPage(summary: Partial<WorkSummary>, opener: WorkPageProps['openDeliverable']): WorkPageProps {
  const work: WorkSummary = {
    sessionId: 's1', goal: null, plan: null, jobs: { total: 0, running: 0, failed: 0, killed: 0 }, trajectoryRecords: 0,
    deliverables: ['out.md'], unindexedResults: 0, acceptance: null, approvals: 0, questions: 0, execution: 'idle', cwd: '/work', ...summary,
  }
  return { wide: true, useWork: (select: (value: WorkSummary) => unknown) => select(work), openDeliverable: opener, openFiles: vi.fn(), verifyWork: vi.fn().mockRejectedValue(new Error('not yet verified')), t } as unknown as WorkPageProps
}

describe('Work interactions and status', () => {
  it('renders a rejected opener as an accessible error and retries without submitting anything', async () => {
    const opener = vi.fn().mockRejectedValueOnce(new Error('file removed')).mockResolvedValue(undefined)
    render(<WorkPage {...workPage({}, opener)} />)
    fireEvent.click(screen.getByRole('button', { name: 'out.md' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'work.retry' }))
    await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
    expect(opener).toHaveBeenCalledTimes(2)
  })

  it('drops an in-flight refusal when switching sessions', async () => {
    let reject!: (reason: Error) => void
    const opener = () => new Promise<void>((_resolve, decline) => { reject = decline })
    const page = render(<WorkPage {...workPage({}, opener)} />)
    fireEvent.click(screen.getByRole('button', { name: 'out.md' }))
    page.rerender(<WorkPage {...workPage({ sessionId: 's2' }, opener)} />)
    reject(new Error('stale refusal'))
    await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
    page.rerender(<WorkPage {...workPage({}, opener)} />)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each(['active', 'paused', 'blocked', 'complete'] as const)('shows %s Goal phase independently from execution', (phase) => {
    render(<WorkPage {...workPage({ goal: { objective: 'Ship', phase }, execution: 'running' }, async () => {})} />)
    expect(screen.getByText(`work.goal.phase.${phase}`)).toBeTruthy()
    expect(screen.getByText('work.execution.running')).toBeTruthy()
  })

  it.each([null, 3])('marks unavailable or incomplete inventory (%s)', (unindexedResults) => {
    render(<WorkPage {...workPage({ unindexedResults }, async () => {})} />)
    expect(screen.getByText(unindexedResults === null ? 'work.inventoryUnavailable' : 'work.inventoryIncomplete')).toBeTruthy()
  })
})

describe('revision-bound user confirmation', () => {
  it('single-flights explicit confirmation and never displays a failed save as accepted', async () => {
    const settled = Promise.withResolvers<import('@relay-harness/rlh-host-work-results/types').WorkAcceptReceipt>()
    const acceptWork = vi.fn(() => settled.promise)
    const initial = workPage({ acceptance: { reviewRevision: 4, acceptedRevision: null, reviewable: true } }, vi.fn())
    const page = render(<WorkPage {...initial} acceptWork={acceptWork} />)
    fireEvent.click(screen.getByRole('button', { name: 'work.acceptance.confirm' }))
    fireEvent.click(screen.getByRole('button', { name: 'work.acceptance.saving' }))
    expect(acceptWork).toHaveBeenCalledTimes(1)
    expect(acceptWork).toHaveBeenCalledWith('s1', 4)
    const incoming = workPage({ acceptance: { reviewRevision: 4, acceptedRevision: 4, reviewable: true } }, vi.fn())
    page.rerender(<WorkPage {...incoming} acceptWork={acceptWork} />)
    expect(screen.queryByText('work.acceptance.current')).toBeNull()
    settled.reject(new Error('disk unavailable'))
    await waitFor(() => { expect(screen.getAllByRole('alert').length).toBeGreaterThan(0) })
    expect(screen.queryByText('work.acceptance.current')).toBeNull()
    expect(screen.getByRole('button', { name: 'work.acceptance.confirm' }).hasAttribute('disabled')).toBe(false)
  })

  it('separates a model-complete goal from an explicit current user receipt', async () => {
    const props = workPage({ goal: { objective: 'Ship', phase: 'complete' }, acceptance: { reviewRevision: 8, acceptedRevision: 3, reviewable: true } }, vi.fn())
    const verifyWork = vi.fn().mockResolvedValue({
      reviewRevision: 8, acceptedRevision: 3, reviewable: true, verifiedThroughSeq: 9, current: true,
    })
    render(<WorkPage {...props} acceptWork={vi.fn()} verifyWork={verifyWork} />)
    expect(screen.getByText('work.goal.phase.complete')).toBeTruthy()
    expect(await screen.findByText('work.acceptance.stale')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'work.acceptance.confirm' }).hasAttribute('disabled')).toBe(false)
  })
})

describe('cross-session Library', () => {
  it('pages outputs with their source identity and surfaces coverage instead of calling a partial scan complete', async () => {
    const first = { sessionId: 'first' as never, path: 'one.txt', cwd: '/one' }
    const second = { sessionId: 'second' as never, path: 'two.txt', cwd: '/two' }
    const queryLibrary = vi.fn()
      .mockResolvedValueOnce({ entries: [first], scannedSessions: 1, totalSessions: 2, unindexedResults: 1, unavailableSessions: 0, next: { sessionOffset: 1, pathOffset: 0, corpusRevision: 'generation' } })
      .mockResolvedValueOnce({
        entries: [second], scannedSessions: 1, totalSessions: 2, unindexedResults: 0, unavailableSessions: 0, next: null,
      })
    const openLibraryOutput = vi.fn().mockResolvedValue(undefined)
    render(<LibraryPage {...{
      wide: true, useSessions: ((select: (state: { current?: string }) => unknown) => select({})) as never,
      expandSidebar: vi.fn(), useWorkspaces: unused,
      queryLibrary, openLibraryOutput, openFiles: vi.fn(), openSettings: vi.fn(), t,
    } as LibraryPageProps} />)
    expect(await screen.findByText('one.txt')).toBeTruthy()
    expect(screen.getByText(/library.partial/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'library.more' }))
    expect(await screen.findByText('two.txt')).toBeTruthy()
    expect(queryLibrary.mock.calls[1]?.[0]).toEqual({ query: '', sessionOffset: 1, pathOffset: 0, corpusRevision: 'generation' })
    fireEvent.click(screen.getByRole('button', { name: 'one.txt' }))
    await waitFor(() => { expect(openLibraryOutput).toHaveBeenCalledWith(first) })
    expect(screen.getByText(/library.endIncomplete/)).toBeTruthy()
    expect(screen.getByText('library.priorUnindexed')).toBeTruthy()
  })
})

function libraryPage(queryLibrary: LibraryPageProps['queryLibrary']): LibraryPageProps {
  return {
    wide: true, useSessions: ((select: (state: { current?: string }) => unknown) => select({})) as never,
    expandSidebar: vi.fn(), useWorkspaces: unused, queryLibrary,
    openLibraryOutput: vi.fn().mockResolvedValue(undefined), openFiles: vi.fn(), openSettings: vi.fn(), t,
  } as LibraryPageProps
}

const emptyLibraryPage = {
  entries: [], scannedSessions: 1, totalSessions: 1, unindexedResults: 0, unavailableSessions: 0, next: null,
}

describe('Work review readiness and independent facts', () => {
  it('makes a result without a Goal discoverable for review', () => {
    render(<WorkPage {...workPage({ acceptance: { reviewRevision: 8, acceptedRevision: null, reviewable: true } }, vi.fn())} acceptWork={vi.fn()} />)
    expect(screen.getByText('work.reviewReady')).toBeTruthy()
    expect(screen.getByText('work.execution.idle')).toBeTruthy()
    expect(screen.getByText('work.scope')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'work.acceptance.confirm' }).hasAttribute('disabled')).toBe(false)
  })

  it.each([
    { execution: 'unknown' }, { execution: 'running' }, { approvals: 1 }, { questions: 1 },
  ] as const)('withholds review when execution or human input is unsettled (%j)', (facts) => {
    const acceptWork = vi.fn()
    const verifyWork = vi.fn()
    render(<WorkPage {...workPage({ ...facts, acceptance: { reviewRevision: 8, acceptedRevision: null, reviewable: true } }, vi.fn())} acceptWork={acceptWork} verifyWork={verifyWork} />)
    fireEvent.click(screen.getByRole('button', { name: 'work.acceptance.confirm' }))
    expect(acceptWork).not.toHaveBeenCalled()
    expect(verifyWork).not.toHaveBeenCalled()
    expect(screen.queryByText('work.reviewReady')).toBeNull()
  })

  it('shows recorded Job failures without changing a completed Goal or declaring overall failure', () => {
    render(<WorkPage {...workPage({
      goal: { objective: 'Ship', phase: 'complete' }, jobs: { total: 3, running: 0, failed: 1, killed: 1 },
    }, vi.fn())} />)
    expect(screen.getByText('work.goal.phase.complete')).toBeTruthy()
    expect(screen.getByText('work.execution.idle')).toBeTruthy()
    expect(screen.getByText('work.jobOutcomes')).toBeTruthy()
    expect(screen.queryByText('work.goal.phase.blocked')).toBeNull()
  })

  it('preserves an unrecognized Goal phase instead of labeling it as successful', () => {
    render(<WorkPage {...workPage({ goal: { objective: 'Ship', phase: 'provider-specific' } }, vi.fn())} />)
    expect(screen.getByText('provider-specific')).toBeTruthy()
    expect(screen.queryByText('work.goal.phase.complete')).toBeNull()
  })
})

describe('Library scan recovery', () => {
  it('handles a synchronous query refusal and retries the submitted query', async () => {
    const queryLibrary = vi.fn().mockImplementationOnce(() => { throw new Error('service unavailable') }).mockResolvedValue(emptyLibraryPage)
    render(<LibraryPage {...libraryPage(queryLibrary)} />)
    expect(await screen.findByRole('alert')).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: 'library.search' }), { target: { value: 'unsent draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'library.retryPage' }))
    await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
    expect(queryLibrary.mock.calls[1]?.[0]).toEqual({ query: '' })
  })

  it('keeps prior coverage gaps across a failed continuation and its successful retry', async () => {
    const next = { sessionOffset: 0, pathOffset: 1, corpusRevision: 'generation' }
    const queryLibrary = vi.fn()
      .mockResolvedValueOnce({ ...emptyLibraryPage, entries: [{ sessionId: 'first', path: 'one.txt' }], unindexedResults: 1, unavailableSessions: 1, next })
      .mockRejectedValueOnce(new Error('temporary read failure'))
      .mockResolvedValueOnce({ ...emptyLibraryPage, entries: [{ sessionId: 'second', path: 'two.txt' }] })
    render(<LibraryPage {...libraryPage(queryLibrary)} />)
    expect(await screen.findByText('one.txt')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'library.more' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText('one.txt')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'library.retryPage' }))
    expect(await screen.findByText('two.txt')).toBeTruthy()
    expect(queryLibrary.mock.calls[2]?.[0]).toEqual({ query: '', ...next })
    expect(screen.getByText('library.priorUnindexed')).toBeTruthy()
    expect(screen.getByText('library.priorUnavailable')).toBeTruthy()
    expect(screen.getByText(/library.endIncomplete/)).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('restarts a stale continuation without its cursor and clears old results and gap flags', async () => {
    const next = { sessionOffset: 1, pathOffset: 0, corpusRevision: 'old-generation' }
    const queryLibrary = vi.fn()
      .mockResolvedValueOnce({ ...emptyLibraryPage, entries: [{ sessionId: 'first', path: 'old.txt' }], unindexedResults: 1, unavailableSessions: 1, next })
      .mockRejectedValueOnce(new Error('corpus changed'))
      .mockResolvedValueOnce(emptyLibraryPage)
    render(<LibraryPage {...libraryPage(queryLibrary)} />)
    expect(await screen.findByText('old.txt')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'library.more' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'library.restart' }))
    await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
    expect(queryLibrary.mock.calls[2]?.[0]).toEqual({ query: '' })
    expect(screen.queryByText('old.txt')).toBeNull()
    expect(screen.queryByText('library.priorUnindexed')).toBeNull()
    expect(screen.queryByText('library.priorUnavailable')).toBeNull()
    expect(screen.queryByText(/library.endIncomplete/)).toBeNull()
    expect(screen.getByText(/library.complete/)).toBeTruthy()
  })
})
