// @vitest-environment jsdom
/** Non-author regressions for confirmation durability and Library operation lifetimes. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { WorkAcceptReceipt, WorkVerifiedReview, WorkLibraryEntry, WorkLibraryPage } from '@relay-harness/rlh-host-work-results/types'
import { WorkPage, type WorkPageProps } from '../src/client/WorkPage.tsx'
import { LibraryPage, type LibraryPageProps } from '../src/client/LibraryPage.tsx'
import type { WorkSummary } from '../src/client/work-projection.ts'

afterEach(cleanup)
const t = ((key: string) => key) as never

function summary(sessionId = 'work-a', acceptedRevision: number | null = null): WorkSummary {
  return {
    sessionId, goal: null, plan: null, jobs: { total: 0, running: 0 }, trajectoryRecords: 0,
    deliverables: ['result.txt'], unindexedResults: 0, approvals: 0, questions: 0,
    acceptance: { reviewRevision: 10, acceptedRevision, reviewable: true }, completion: 'idle', cwd: '/workspace',
  }
}

function verified(reviewRevision = 10): WorkVerifiedReview {
  return { reviewRevision, acceptedRevision: reviewRevision, reviewable: true, verifiedThroughSeq: reviewRevision + 1, current: true }
}

function workProps(
  work: WorkSummary,
  verifyWork: WorkPageProps['verifyWork'],
  acceptWork: WorkPageProps['acceptWork'] = vi.fn().mockResolvedValue({ reviewedThroughSeq: 10, recordedSeq: 11, current: true }),
): WorkPageProps {
  return {
    wide: true, useWork: (select: (value: WorkSummary) => unknown) => select(work),
    verifyWork, acceptWork, openDeliverable: vi.fn().mockResolvedValue(undefined), openFiles: vi.fn(), t,
  } as unknown as WorkPageProps
}

const entry: WorkLibraryEntry = { sessionId: 'source-a' as WorkLibraryEntry['sessionId'], cwd: '/workspace', path: 'result.txt' }
const page: WorkLibraryPage = {
  entries: [entry], scannedSessions: 1, totalSessions: 1, unindexedResults: 0, unavailableSessions: 0, next: null,
}

function libraryProps(
  queryLibrary: LibraryPageProps['queryLibrary'],
  openLibraryOutput: LibraryPageProps['openLibraryOutput'],
  wide = true,
): LibraryPageProps {
  return {
    wide, queryLibrary, openLibraryOutput, openFiles: vi.fn(), openSettings: vi.fn(),
    useSessions: (select: (value: unknown) => unknown) => select({ current: 'work-a' }), t,
  } as unknown as LibraryPageProps
}

describe('verified Work confirmation', () => {
  it('does not resurrect a failed receipt from the raw projection after unmount and remount', async () => {
    const acceptance = Promise.withResolvers<WorkAcceptReceipt>()
    const accept = vi.fn<WorkPageProps['acceptWork']>().mockReturnValue(acceptance.promise)
    const verify = vi.fn<WorkPageProps['verifyWork']>().mockRejectedValue(new Error('disk is unavailable'))
    const view = render(<WorkPage {...workProps(summary(), verify, accept)} />)
    fireEvent.click(screen.getByRole('button', { name: 'work.acceptance.confirm' }))
    view.rerender(<WorkPage {...workProps(summary('work-a', 10), verify, accept)} />)
    expect(screen.queryByText('work.acceptance.current')).toBeNull()
    await act(async () => { acceptance.reject(new Error('receipt flush failed')); await Promise.resolve() })
    expect(await screen.findByText('work.acceptance.failed')).toBeTruthy()
    expect(screen.queryByText('work.acceptance.current')).toBeNull()
    view.unmount()
    render(<WorkPage {...workProps(summary('work-a', 10), verify, accept)} />)
    expect(await screen.findByText('work.acceptance.checkFailed')).toBeTruthy()
    expect(screen.queryByText('work.acceptance.current')).toBeNull()
    expect(accept).toHaveBeenCalledOnce()
  })

  it('requires each mounted view to verify the shared raw receipt instead of inferring durability from it', async () => {
    const first = Promise.withResolvers<WorkVerifiedReview>()
    const second = Promise.withResolvers<WorkVerifiedReview>()
    const verify = vi.fn<WorkPageProps['verifyWork']>().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const raw = summary('work-a', 10)
    render(<><div data-testid="first-view"><WorkPage {...workProps(raw, verify)} /></div><div data-testid="second-view"><WorkPage {...workProps(raw, verify)} /></div></>)
    expect(screen.queryByText('work.acceptance.current')).toBeNull()
    await act(async () => { first.reject(new Error('flush failed')); second.reject(new Error('flush failed')); await Promise.resolve() })
    await waitFor(() => { expect(screen.getAllByText('work.acceptance.checkFailed')).toHaveLength(2) })
    expect(within(screen.getByTestId('first-view')).queryByText('work.acceptance.current')).toBeNull()
    expect(within(screen.getByTestId('second-view')).queryByText('work.acceptance.current')).toBeNull()
    expect(verify).toHaveBeenCalledTimes(2)
  })

  it('verifies a newly observed cross-view receipt even though the reviewed revision did not move', async () => {
    const reading = Promise.withResolvers<WorkVerifiedReview>()
    const verify = vi.fn<WorkPageProps['verifyWork']>().mockReturnValue(reading.promise)
    const view = render(<WorkPage {...workProps(summary(), verify)} />)
    expect(screen.queryByText('work.acceptance.current')).toBeNull()
    view.rerender(<WorkPage {...workProps(summary('work-a', 10), verify)} />)
    expect(verify).toHaveBeenCalled()
    expect(screen.queryByText('work.acceptance.current')).toBeNull()
    await act(async () => { reading.resolve(verified()); await Promise.resolve() })
    expect(await screen.findByText('work.acceptance.current')).toBeTruthy()
  })

  it('restarts an in-flight older-receipt read when another view confirms the same review revision', async () => {
    const prior = Promise.withResolvers<WorkVerifiedReview>()
    const latest = Promise.withResolvers<WorkVerifiedReview>()
    const verify = vi.fn<WorkPageProps['verifyWork']>().mockReturnValueOnce(prior.promise).mockReturnValueOnce(latest.promise)
    const view = render(<WorkPage {...workProps(summary('work-a', 9), verify)} />)
    expect(verify).toHaveBeenCalledOnce()
    // The receipt event changes acceptedRevision, not reviewRevision.
    view.rerender(<WorkPage {...workProps(summary('work-a', 10), verify)} />)
    expect(verify).toHaveBeenCalledTimes(2)
    expect(verify.mock.calls[0]?.[1].aborted).toBe(true)
    await act(async () => { latest.resolve(verified()); await Promise.resolve() })
    expect(await screen.findByText('work.acceptance.current')).toBeTruthy()
    await act(async () => { prior.resolve({ ...verified(), acceptedRevision: 9 }); await Promise.resolve() })
    expect(screen.getByText('work.acceptance.current')).toBeTruthy()
  })

  it('keeps current:false authoritative while an old raw receipt and verified cut arrive late', async () => {
    const acceptance = Promise.withResolvers<WorkAcceptReceipt>()
    const staleCheck = Promise.withResolvers<WorkVerifiedReview>()
    const verify = vi.fn<WorkPageProps['verifyWork']>().mockReturnValueOnce(staleCheck.promise).mockResolvedValue(verified())
    const accept = vi.fn<WorkPageProps['acceptWork']>().mockReturnValue(acceptance.promise)
    const view = render(<WorkPage {...workProps(summary(), verify, accept)} />)
    fireEvent.click(screen.getByRole('button', { name: 'work.acceptance.confirm' }))
    view.rerender(<WorkPage {...workProps(summary('work-a', 10), verify, accept)} />)
    await act(async () => {
      acceptance.resolve({ reviewedThroughSeq: 10, recordedSeq: 11, current: false })
      await Promise.resolve()
    })
    await waitFor(() => { expect(verify).toHaveBeenCalledTimes(2) })
    expect(verify.mock.calls[0]?.[1].aborted).toBe(true)
    await act(async () => { staleCheck.resolve(verified()); await Promise.resolve() })
    await waitFor(() => { expect(screen.getByText('work.acceptance.stale')).toBeTruthy() })
    expect(screen.queryByText('work.acceptance.current')).toBeNull()
  })

  it('ignores an old Session verification after switching to a separately verified Session', async () => {
    const previous = Promise.withResolvers<WorkVerifiedReview>()
    const verify = vi.fn<WorkPageProps['verifyWork']>().mockReturnValueOnce(previous.promise).mockResolvedValue(verified())
    const view = render(<WorkPage {...workProps(summary('work-a', 10), verify)} />)
    view.rerender(<WorkPage {...workProps(summary('work-b', 10), verify)} />)
    expect(await screen.findByText('work.acceptance.current')).toBeTruthy()
    expect(verify.mock.calls[0]?.[1].aborted).toBe(true)
    await act(async () => { previous.reject(new Error('old Session read failed')); await Promise.resolve() })
    expect(screen.getByText('work.acceptance.current')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('Library operation lifetimes', () => {
  it.each(['resolve', 'reject'] as const)('allows reopening after collapse invalidates a pending opener that will %s', async (settlement) => {
    const opening = Promise.withResolvers<undefined>()
    const open = vi.fn<LibraryPageProps['openLibraryOutput']>().mockReturnValueOnce(opening.promise).mockResolvedValue(undefined)
    const query = vi.fn<LibraryPageProps['queryLibrary']>().mockResolvedValue(page)
    const view = render(<LibraryPage {...libraryProps(query, open)} />)
    fireEvent.click(await screen.findByRole('button', { name: 'result.txt' }))
    expect(screen.getByRole('button', { name: 'result.txt' }).hasAttribute('disabled')).toBe(true)
    view.rerender(<LibraryPage {...libraryProps(query, open, false)} />)
    await act(async () => {
      if (settlement === 'resolve') opening.resolve(undefined)
      else opening.reject(new Error('late native refusal'))
      await Promise.resolve()
    })
    view.rerender(<LibraryPage {...libraryProps(query, open)} />)
    const button = await screen.findByRole('button', { name: 'result.txt' })
    expect(button.hasAttribute('disabled')).toBe(false)
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(button)
    await waitFor(() => { expect(button.hasAttribute('disabled')).toBe(false) })
    expect(open).toHaveBeenCalledTimes(2)
    expect(open.mock.calls[1]?.[0]).toEqual(entry)
  })

  it('does not attribute an old output refusal to a newly submitted Library query', async () => {
    const opening = Promise.withResolvers<undefined>()
    const open = vi.fn<LibraryPageProps['openLibraryOutput']>().mockReturnValue(opening.promise)
    const next = { ...page, entries: [{ ...entry, path: 'different.txt' }] }
    const query = vi.fn<LibraryPageProps['queryLibrary']>().mockResolvedValueOnce(page).mockResolvedValue(next)
    render(<LibraryPage {...libraryProps(query, open)} />)
    fireEvent.click(await screen.findByRole('button', { name: 'result.txt' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'library.search' }), { target: { value: 'different' } })
    fireEvent.click(screen.getByRole('button', { name: 'library.searchAction' }))
    expect(await screen.findByRole('button', { name: 'different.txt' })).toBeTruthy()
    await act(async () => { opening.reject(new Error('old result no longer exists')); await Promise.resolve() })
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
