// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import type { WorkContentCurrency, WorkContentReviewRead } from '@relay-harness/rlh-host-work-results/types'
import { WorkPage, type WorkPageProps } from '../src/client/WorkPage.tsx'
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

function workProps(work: WorkSummary, contentReview: WorkPageProps['contentReview']): WorkPageProps {
  return {
    active: true, renderSlot: () => null, openConversation: vi.fn(), startWork: vi.fn(), openSource: vi.fn(),
    useWork: (select: (value: WorkSummary) => unknown) => select(work),
    verifyWork: vi.fn().mockResolvedValue({ reviewRevision: 8, acceptedRevision: 8, reviewable: true, current: true, confirmationBlockedBy: [], verifiedThroughSeq: 9 }),
    acceptWork: vi.fn(), openDeliverable: vi.fn(), contentReview, openFiles: vi.fn(), t,
  } as unknown as WorkPageProps
}

function read(currency: readonly WorkContentCurrency[], review: WorkContentReviewRead['review'] = { reviewId: 'r1' as never, decision: 'approved' as const }): WorkContentReviewRead {
  return { review, currency }
}

describe('Work content-review badge', () => {
  it.each([
    { currency: [{ ref: 'a', state: 'matches-confirmed' }], expected: 'work.contentReview.matches-confirmed' },
    {
      currency: [{ ref: 'a', state: 'matches-confirmed' }, { ref: 'b', state: 'changed-unreviewed', current: {} as never }],
      expected: 'work.contentReview.changed-unreviewed',
    },
    { currency: [{ ref: 'a', state: 'not-reverified' }], expected: 'work.contentReview.not-reverified' },
    {
      currency: [{ ref: 'a', state: 'not-reverified' }, { ref: 'b', state: 'changed-unreviewed', current: {} as never }],
      expected: 'work.contentReview.changed-unreviewed',
    },
  ])('aggregates $expected as the worst per-version currency state', async ({ currency, expected }) => {
    const contentReview = vi.fn().mockResolvedValue(read(currency))
    render(<WorkPage {...workProps(summary(), contentReview)} />)
    expect(await screen.findByText(expected)).toBeTruthy()
    expect(screen.getByText((_, el) => el?.textContent === `work.contentReview: ${expected}`)).toBeTruthy()
  })

  it('renders no badge before the first content review or on a failed read', async () => {
    const contentReview = vi.fn().mockResolvedValueOnce(read([], null)).mockRejectedValueOnce(new Error('read failed'))
    const view = render(<WorkPage {...workProps(summary(), contentReview)} />)
    expect(contentReview).toHaveBeenCalledWith('s1', expect.anything())
    expect(screen.queryByText((_, el) => el?.textContent.startsWith('work.contentReview:') ?? false)).toBeNull()
    view.rerender(<WorkPage {...workProps(summary({ epoch: 2 }), contentReview)} />)
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByText((_, el) => el?.textContent.startsWith('work.contentReview:') ?? false)).toBeNull()
  })

  it('keeps a late reply from an older handshake out of the current badge', async () => {
    const old = Promise.withResolvers<WorkContentReviewRead>()
    const current = Promise.withResolvers<WorkContentReviewRead>()
    const contentReview = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    const view = render(<WorkPage {...workProps(summary(), contentReview)} />)
    view.rerender(<WorkPage {...workProps(summary({ epoch: 2 }), contentReview)} />)
    expect(contentReview).toHaveBeenCalledTimes(2)
    expect((contentReview.mock.calls[0]?.[1] as { aborted: boolean } | undefined)?.aborted).toBe(true)
    await act(async () => { old.resolve(read([{ ref: 'a', state: 'matches-confirmed' }])); await Promise.resolve() })
    expect(screen.queryByText((_, el) => el?.textContent.startsWith('work.contentReview:') ?? false)).toBeNull()
    await act(async () => { current.resolve(read([{ ref: 'a', state: 'not-reverified' }])); await Promise.resolve() })
    expect(await screen.findByText('work.contentReview.not-reverified')).toBeTruthy()
  })

  it('hides the badge while the page is not synchronized and restores it on readiness', async () => {
    const contentReview = vi.fn().mockResolvedValue(read([{ ref: 'a', state: 'matches-confirmed' }]))
    const view = render(<WorkPage {...workProps(summary({ availability: 'disconnected' }), contentReview)} />)
    expect(contentReview).not.toHaveBeenCalled()
    expect(screen.queryByText((_, el) => el?.textContent.startsWith('work.contentReview:') ?? false)).toBeNull()
    view.rerender(<WorkPage {...workProps(summary(), contentReview)} />)
    expect(await screen.findByText('work.contentReview.matches-confirmed')).toBeTruthy()
  })
})
