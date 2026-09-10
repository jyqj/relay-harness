// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ConnectionHandle } from '@relay-harness/rlh-api-remotes/client'
import type { WorkLibraryPage, WorkVerifiedReview, WorkAcceptReceipt } from '@relay-harness/rlh-host-work-results/types'
import { WorkPage, type WorkPageProps } from '../src/client/WorkPage.tsx'
import { LibraryPage, type LibraryPageProps } from '../src/client/LibraryPage.tsx'
import type { WorkSummary } from '../src/client/work-projection.ts'

afterEach(cleanup)
const t = ((key: string) => key) as never

function summary(changes: Partial<WorkSummary> = {}): WorkSummary {
  return {
    sessionId: 's1', epoch: 1, availability: 'ready', execution: 'idle', cwd: '/one', goal: null, plan: null,
    jobs: { total: 0, running: 0, failed: 0, killed: 0 }, approvals: 0, questions: 0,
    trajectoryRecords: 0, deliverables: ['out.md'], unindexedResults: 0,
    acceptance: { reviewRevision: 8, acceptedRevision: 8, reviewable: true }, ...changes,
  }
}
const verified: WorkVerifiedReview = { reviewRevision: 8, acceptedRevision: 8, reviewable: true, current: true, verifiedThroughSeq: 9 }
function workProps(work: WorkSummary, verifyWork: WorkPageProps['verifyWork'], acceptWork = vi.fn(), openDeliverable = vi.fn()): WorkPageProps {
  return { wide: true, useWork: (select: (value: WorkSummary) => unknown) => select(work), verifyWork, acceptWork, openDeliverable, openFiles: vi.fn(), t } as unknown as WorkPageProps
}

describe('Work generation-bound actions', () => {
  it('reverifies an unchanged revision after a new handshake and ignores the prior success', async () => {
    const old = Promise.withResolvers<WorkVerifiedReview>()
    const current = Promise.withResolvers<WorkVerifiedReview>()
    const verifyWork = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    const view = render(<WorkPage {...workProps(summary(), verifyWork)} />)
    view.rerender(<WorkPage {...workProps(summary({ epoch: 2 }), verifyWork)} />)
    expect(verifyWork).toHaveBeenCalledTimes(2)
    expect(verifyWork.mock.calls[0]?.[1].aborted).toBe(true)
    await act(async () => { old.resolve(verified); await Promise.resolve() })
    expect(screen.queryByText('work.acceptance.current')).toBeNull()
    await act(async () => { current.resolve(verified); await Promise.resolve() })
    expect(await screen.findByText('work.acceptance.current')).toBeTruthy()
  })

  it.each(['disconnected', 'synchronizing', 'loading', 'error', 'removed'] as const)('disables review and opening while %s even with stale ready facts', (availability) => {
    const verifyWork = vi.fn()
    const acceptWork = vi.fn()
    const opener = vi.fn()
    render(<WorkPage {...workProps(summary({ availability }), verifyWork, acceptWork, opener)} />)
    expect(screen.getByText('work.staleFacts')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'work.acceptance.confirm' }))
    fireEvent.click(screen.getByRole('button', { name: 'out.md' }))
    expect(acceptWork).not.toHaveBeenCalled()
    expect(opener).not.toHaveBeenCalled()
    expect(verifyWork).not.toHaveBeenCalled()
  })

  it.each(['resolve', 'reject'] as const)('retires a pending confirmation on disconnect before its %s', async (settlement) => {
    const pending = Promise.withResolvers<WorkAcceptReceipt>()
    const accept = vi.fn().mockReturnValue(pending.promise)
    const verifyWork = vi.fn().mockResolvedValue(verified)
    const work = summary({ acceptance: { reviewRevision: 8, acceptedRevision: null, reviewable: true } })
    const view = render(<WorkPage {...workProps(work, verifyWork, accept)} />)
    fireEvent.click(screen.getByRole('button', { name: 'work.acceptance.confirm' }))
    view.rerender(<WorkPage {...workProps({ ...work, availability: 'disconnected' }, verifyWork, accept)} />)
    await act(async () => {
      if (settlement === 'resolve') pending.resolve({ reviewedThroughSeq: 8, recordedSeq: 9, current: true })
      else pending.reject(new Error('old write failed'))
      await Promise.resolve()
    })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText('work.acceptance.current')).toBeNull()
    expect(verifyWork).not.toHaveBeenCalled()
  })

  it('captures synchronous verification, confirmation, and file-open failures as page errors', async () => {
    const throwing = () => { throw new Error('synchronous refusal') }
    const view = render(<WorkPage {...workProps(summary(), throwing, vi.fn(throwing), vi.fn(throwing))} />)
    expect(await screen.findByText('work.acceptance.checkFailed')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'work.acceptance.confirm' }))
    expect(await screen.findByText('work.acceptance.failed')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'out.md' }))
    expect(await screen.findByText('work.openFailed')).toBeTruthy()
    view.unmount()
  })

  it('does not carry an old handshake superseded marker into a freshly verified receipt', async () => {
    const verifyWork = vi.fn().mockResolvedValue(verified)
    const accept = vi.fn().mockResolvedValue({ reviewedThroughSeq: 8, recordedSeq: 9, current: false })
    const work = summary({ acceptance: { reviewRevision: 8, acceptedRevision: null, reviewable: true } })
    const view = render(<WorkPage {...workProps(work, verifyWork, accept)} />)
    fireEvent.click(screen.getByRole('button', { name: 'work.acceptance.confirm' }))
    await waitFor(() => { expect(screen.queryByText('work.acceptance.saving')).toBeNull() })
    view.rerender(<WorkPage {...workProps(summary({ epoch: 2 }), verifyWork, accept)} />)
    expect(await screen.findByText('work.acceptance.current')).toBeTruthy()
  })
})

type Readiness = ReturnType<ConnectionHandle['readiness']['getSnapshot']>
const page: WorkLibraryPage = {
  entries: [{ sessionId: 's1' as never, path: 'old.md' }], scannedSessions: 1, totalSessions: 2,
  unindexedResults: 1, unavailableSessions: 0,
  next: { sessionOffset: 1, pathOffset: 0, corpusRevision: 'old-corpus' as never },
}
function libraryProps(connection: Readiness, queryLibrary: LibraryPageProps['queryLibrary'], opener = vi.fn()): LibraryPageProps {
  return {
    wide: true, useConnection: (select: (value: Readiness) => unknown) => select(connection),
    useSessions: (select: (value: { current: string }) => unknown) => select({ current: 's1' }),
    queryLibrary, openLibraryOutput: opener, openFiles: vi.fn(), openSettings: vi.fn(), t,
  } as unknown as LibraryPageProps
}

describe('Library connection generations', () => {
  it('keeps an offline draft but repulls only the submitted query without the old cursor', async () => {
    const reload = Promise.withResolvers<WorkLibraryPage>()
    const query = vi.fn().mockResolvedValueOnce(page).mockResolvedValueOnce(page).mockReturnValueOnce(reload.promise)
    const opener = vi.fn()
    const view = render(<LibraryPage {...libraryProps({ phase: 'ready', epoch: 1 }, query, opener)} />)
    await screen.findByText('old.md')
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'submitted' } })
    fireEvent.click(screen.getByRole('button', { name: 'library.searchAction' }))
    await screen.findByText('old.md')
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'unsent changes' } })
    view.rerender(<LibraryPage {...libraryProps({ phase: 'reconnecting', epoch: 1 }, query, opener)} />)
    expect(screen.getByText('library.reconnecting')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'old.md' }))
    fireEvent.click(screen.getByRole('button', { name: 'library.more' }))
    fireEvent.click(screen.getByRole('button', { name: 'library.searchAction' }))
    expect(opener).not.toHaveBeenCalled()
    expect(query).toHaveBeenCalledTimes(2)
    view.rerender(<LibraryPage {...libraryProps({ phase: 'synchronizing', epoch: 2 }, query, opener)} />)
    expect(query).toHaveBeenCalledTimes(2)
    view.rerender(<LibraryPage {...libraryProps({ phase: 'ready', epoch: 2 }, query, opener)} />)
    expect(query.mock.calls[2]?.[0]).toEqual({ query: 'submitted' })
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('unsent changes')
    expect(screen.queryByText('old.md')).toBeNull()
    await act(async () => { reload.resolve({ ...page, entries: [], next: null, unindexedResults: 0 }); await Promise.resolve() })
    expect(screen.queryByText('library.priorUnindexed')).toBeNull()
    expect(screen.queryByText(/library.endIncomplete/)).toBeNull()
  })

  it.each(['resolve', 'reject'] as const)('ignores a previous generation query %s after reconnection', async (settlement) => {
    const old = Promise.withResolvers<WorkLibraryPage>()
    const query = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue({ ...page, entries: [{ sessionId: 's2', path: 'fresh.md' }] })
    const view = render(<LibraryPage {...libraryProps({ phase: 'ready', epoch: 1 }, query)} />)
    view.rerender(<LibraryPage {...libraryProps({ phase: 'ready', epoch: 2 }, query)} />)
    expect(query.mock.calls[0]?.[1].aborted).toBe(true)
    await screen.findByText('fresh.md')
    await act(async () => {
      if (settlement === 'resolve') old.resolve(page)
      else old.reject(new Error('old scan rejected'))
      await Promise.resolve()
    })
    expect(screen.queryByText('old.md')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('fresh.md')).toBeTruthy()
  })

  it('retires an in-flight native opener when connection readiness is lost', async () => {
    const pending = Promise.withResolvers<void>()
    const open = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined)
    const query = vi.fn().mockResolvedValue(page)
    const view = render(<LibraryPage {...libraryProps({ phase: 'ready', epoch: 1 }, query, open)} />)
    fireEvent.click(await screen.findByRole('button', { name: 'old.md' }))
    view.rerender(<LibraryPage {...libraryProps({ phase: 'reconnecting', epoch: 1 }, query, open)} />)
    await act(async () => { pending.reject(new Error('native opener from old connection')); await Promise.resolve() })
    expect(screen.queryByRole('alert')).toBeNull()
    view.rerender(<LibraryPage {...libraryProps({ phase: 'ready', epoch: 2 }, query, open)} />)
    const button = await screen.findByRole('button', { name: 'old.md' })
    expect(button.hasAttribute('disabled')).toBe(false)
    fireEvent.click(button)
    await waitFor(() => { expect(open).toHaveBeenCalledTimes(2) })
  })
})
