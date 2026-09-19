import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@relay-harness/cordis'
import SessionStore, { Session, SessionId } from '@relay-harness/rlh-session'
import SessionProjectionRegistry from '@relay-harness/rlh-session-projection'
import { contentCurrency, latestContentReviewRead, readContentReview, workContentReviewProjection } from '../src/content-review.ts'
import type { WorkCheckId, WorkContentReview, WorkContentReviewId, WorkContentVersion } from '../src/types.ts'

let ctx: Context | undefined
afterEach(async () => { await ctx?.fiber.dispose(); ctx = undefined })

async function harness() {
  ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(Object.assign((inner: Context) => { inner.sessionProjections.register(workContentReviewProjection) }, { inject: ['sessionProjections'] }))
  return ctx
}

function version(digest: string, locator = 'report.md'): WorkContentVersion {
  return {
    execution: { sessionId: SessionId('reviewed-work'), cwd: '/tmp/work' },
    source: { sessionId: SessionId('reviewed-work'), throughSeq: 3 },
    locator,
    contentHash: { algorithm: 'sha256', digest },
    observedAt: 1000,
  }
}

function review(overrides: Partial<WorkContentReview> = {}): WorkContentReview {
  return {
    reviewId: 'review-1' as WorkContentReviewId, decision: 'approved',
    contentVersions: [version('a'.repeat(64))],
    contentVersionRefs: ['a'.repeat(64)],
    checkRecords: [{
      checkId: 'check-1' as WorkCheckId, checker: { name: 'vitest', version: '1.0' },
      contentVersionRefs: ['a'.repeat(64)], exitCode: 0, verdict: 'pass',
      evidence: 'host-captured',
    }],
    checkRecordRefs: ['check-1'],
    actor: 'host-client', reviewedAt: 2000,
    ...overrides,
  }
}

function record(session: Session, data: unknown): void {
  session.append('work/reviewed', data as WorkContentReview)
}

describe('explicit content reviews', () => {
  it('folds the latest review from the durable log and survives restore', async () => {
    const host = await harness()
    const session = host.sessions.create(SessionId('reviewed-work'))
    record(session, review({ reviewId: 'review-1' as WorkContentReviewId, decision: 'rejected' }))
    record(session, review({ reviewId: 'review-2' as WorkContentReviewId }))
    const restored = Session.fromRestore(session.id, structuredClone(session.events), structuredClone(session.header))
    const folded = restored.events.reduce((state, event) => workContentReviewProjection.apply(state, event), workContentReviewProjection.init())
    expect(folded).toEqual({ latest: review({ reviewId: 'review-2' as WorkContentReviewId }), total: 2 })
    expect(host.sessionProjections.snapshot(session).values.workContentReviews).toEqual({ latest: review({ reviewId: 'review-2' as WorkContentReviewId }), total: 2 })
    expect(workContentReviewProjection.apply({ latest: null, total: 0 }, { type: 'turn/start', seq: 9, time: 1, data: { turn: 1 } } as never)).toEqual({ latest: null, total: 0 })
  })

  it('decodes a review only when every content-version and check-record reference resolves', () => {
    expect(readContentReview(review())).toMatchObject({ reviewId: 'review-1', decision: 'approved' })
    expect(() => readContentReview(review({ contentVersionRefs: ['b'.repeat(64)] }))).toThrow(/unconfirmed content-version ref/)
    expect(() => readContentReview(review({ checkRecordRefs: ['check-2'] }))).toThrow(/unresolved check-record ref/)
    const unknownInput = { ...review().checkRecords[0]!, contentVersionRefs: ['c'.repeat(64)] }
    expect(() => readContentReview(review({ checkRecords: [unknownInput] }))).toThrow(/unknown content version/)
    expect(() => readContentReview(review({ contentVersionRefs: ['a'.repeat(64), 'a'.repeat(64)] }))).toThrow(/duplicate/)
    expect(() => readContentReview({ ...review(), actor: 'agent' })).toThrow()
    expect(() => readContentReview({ ...review(), contentVersions: [version('short')] })).toThrow()
  })

  it('separates the confirmed version from the unverified current file on the read side', () => {
    const confirmed = version('a'.repeat(64))
    expect(contentCurrency(confirmed, undefined)).toEqual({ ref: 'a'.repeat(64), state: 'not-reverified' })
    expect(contentCurrency(confirmed, version('a'.repeat(64)))).toEqual({ ref: 'a'.repeat(64), state: 'matches-confirmed' })
    const changed = contentCurrency(confirmed, version('b'.repeat(64), 'report.md'))
    expect(changed).toEqual({ ref: 'a'.repeat(64), state: 'changed-unreviewed', current: version('b'.repeat(64)) })
    const read = latestContentReviewRead(review())
    expect(read.review).toMatchObject({ decision: 'approved' })
    expect(read.currency).toEqual([{ ref: 'a'.repeat(64), state: 'not-reverified' }])
    expect(latestContentReviewRead(null)).toEqual({ review: null, currency: [] })
  })
})
