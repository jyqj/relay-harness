/** Pure decode, whole-log fold and confirmed-vs-current reads for explicit content reviews. */
import { z, type ZodType } from 'zod'
import type { ProjectionDefinition } from '@relay-harness/rlh-session-projection'
import type {
  WorkContentCurrency, WorkContentReview, WorkContentReviewsProjection, WorkContentVersion,
} from './types.ts'

/** Durable wire schema; every ref must resolve inside the same review. */
const contentVersionData = z.object({
  execution: z.object({ sessionId: z.string(), cwd: z.string().optional() }).strict(),
  source: z.object({ sessionId: z.string(), throughSeq: z.number().int().nonnegative() }).strict(),
  locator: z.string().min(1),
  contentHash: z.object({ algorithm: z.literal('sha256'), digest: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
  observedAt: z.number().int().nonnegative(),
}).strict()

const checkRecordData = z.object({
  checkId: z.string().min(1),
  checker: z.object({
    name: z.string().min(1), version: z.string().optional(),
    configDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  }).strict(),
  contentVersionRefs: z.array(z.string()).refine(refs => new Set(refs).size === refs.length, 'duplicate content-version ref'),
  exitCode: z.number().int().optional(),
  verdict: z.enum(['pass', 'fail', 'unknown']),
  log: z.object({ sessionId: z.string(), seq: z.number().int().nonnegative() }).strict().optional(),
  evidence: z.enum(['agent-claimed', 'host-captured', 'user-reviewed']),
}).strict()

const contentReviewData = z.object({
  reviewId: z.string().min(1),
  decision: z.enum(['approved', 'rejected']),
  contentVersions: z.array(contentVersionData),
  contentVersionRefs: z.array(z.string()).refine(refs => new Set(refs).size === refs.length, 'duplicate content-version ref'),
  checkRecords: z.array(checkRecordData),
  checkRecordRefs: z.array(z.string()).refine(refs => new Set(refs).size === refs.length, 'duplicate check-record ref'),
  actor: z.literal('host-client'),
  reviewedAt: z.number().int().nonnegative(),
}).strict()

/** Reviews the review actually decides about; a carried but unconfirmed version is allowed. */
function resolveRefs(review: WorkContentReview): void {
  const digests = new Set(review.contentVersions.map(version => version.contentHash.digest))
  for (const ref of review.contentVersionRefs) {
    if (!digests.has(ref)) throw new Error('workResults content review has an unconfirmed content-version ref')
  }
  const checks = new Set<string>(review.checkRecords.map(record => record.checkId))
  for (const ref of review.checkRecordRefs) {
    if (!checks.has(ref)) throw new Error('workResults content review has an unresolved check-record ref')
  }
  for (const record of review.checkRecords) {
    for (const ref of record.contentVersionRefs) {
      if (!digests.has(ref)) throw new Error('workResults check record consumed an unknown content version')
    }
  }
}

/**
 * Decode a content review read from a durable or live source event.
 * @param data - serialized event data at the log boundary.
 * @returns the validated review with every reference resolved.
 */
export function readContentReview(data: unknown): WorkContentReview {
  const review = contentReviewData.parse(data) as unknown as WorkContentReview
  resolveRefs(review)
  return review
}

/** Whole-log fold of the latest explicit content review; the event never invalidates itself. */
export const workContentReviewProjection: ProjectionDefinition<'workContentReviews', WorkContentReviewsProjection> = {
  key: 'workContentReviews',
  stateVersion: 1,
  // Branded ids are strings on the wire; the cast keeps the declared projection type.
  schema: z.object({
    latest: contentReviewData.nullable(), total: z.number().int().nonnegative(),
  }).strict() as unknown as ZodType<WorkContentReviewsProjection>,
  init: () => ({ latest: null, total: 0 }),
  apply: (state, event) => {
    if (event.type !== 'work/reviewed') return state
    return { latest: readContentReview(event.data), total: state.total + 1 }
  },
  view: state => state,
}

/**
 * Compare one confirmed version against a fresh observation of the same locator.
 * @param confirmed - the version the recorded decision binds.
 * @param current - a fresh host-side observation, or undefined when the locator was not re-read.
 * @returns The honest state: identical digest, changed-unreviewed with the observed identity, or not-reverified.
 */
export function contentCurrency(confirmed: WorkContentVersion, current: WorkContentVersion | undefined): WorkContentCurrency {
  const ref = confirmed.contentHash.digest
  if (current === undefined) return { ref, state: 'not-reverified' }
  // Currency requires the SAME algorithm; `algorithm` is pinned to one literal today but the
  // vocabulary widens, so this comparison guards future union growth rather than being dead.
  // oxlint-disable-next-line typescript/no-unnecessary-condition
  if (current.contentHash.algorithm === confirmed.contentHash.algorithm
    && current.contentHash.digest === confirmed.contentHash.digest) return { ref, state: 'matches-confirmed' }
  return { ref, state: 'changed-unreviewed', current }
}

/** Whether a fresh submission repeats the latest recorded review's subject. */
export function sameContentSubject(a: WorkContentReview, b: WorkContentReview): boolean {
  const subject = (review: WorkContentReview) => JSON.stringify([review.decision, review.contentVersions,
    review.contentVersionRefs, review.checkRecords, review.checkRecordRefs])
  return subject(a) === subject(b)
}

/** Read-side currency for the latest review without any fresh observation promise. */
export function latestContentReviewRead(latest: WorkContentReview | null): {
  review: WorkContentReview | null
  currency: WorkContentCurrency[]
} {
  if (latest === null) return { review: null, currency: [] }
  return { review: latest, currency: latest.contentVersionRefs.map(ref => ({ ref, state: 'not-reverified' as const })) }
}
