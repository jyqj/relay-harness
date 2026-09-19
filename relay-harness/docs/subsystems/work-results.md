# Work records and Library

English | [中文](work-results.zh.md)

The [Work Results adapter](../../packages/host/work-results/README.md) owns log-prefix confirmation and bounded cross-session deliverable discovery. Session logs remain authoritative; there is no separate Work database. A receipt records a trusted Host client's explicit confirmation, not a file digest, a test result, or a permission grant.

Verified reads and successful confirmation replies require the corresponding persisted log prefix. Raw projections may invalidate displayed confirmation but cannot establish durability. Opening a captured output delegates authorization to the existing Host opener; source attribution does not grant access.

Explicit content reviews are separate from log-prefix confirmation: a `work/reviewed` event binds a user decision to declared content-version digests and check records, never to a log prefix, and the read reports `not-reverified` currency until an actual re-read. Existing `work/accepted` semantics are unchanged.

## DeliverablesProjection

```ts type-equiv
/** Whole-session inventory of execution-recorded, tool-declared file mutations. */
interface DeliverablesProjection {
  /** Unique declared paths in first successful execution order. */
  readonly paths: readonly string[]
  /** Successful root results without execution-time capture; the historical inventory is incomplete. */
  readonly unindexedResults: number
}
```

## WorkAcceptanceProjection

```ts type-equiv
/** Projection of a user's acceptance against an exact Session log prefix. */
interface WorkAcceptanceProjection {
  /** Last non-acceptance event; -1 means no reviewable log. */
  readonly reviewRevision: number
  /** Whether the latest turn boundary is terminal rather than open. */
  readonly reviewable: boolean
  /** Last explicitly accepted revision; null means no user acceptance. */
  readonly acceptedRevision: number | null
}
```

## WorkVerifiedReview

```ts type-equiv
/** A captured review cut whose receipt is confirmed in durable storage. */
interface WorkVerifiedReview extends WorkAcceptanceProjection {
  /** Advisory live eligibility; accept always rechecks the same policy under maintenance. */
  readonly confirmationBlockedBy: readonly WorkConfirmationBlocker[]
  /** Durable cut verified by the Host; -1 when there is no receipt to verify. */
  readonly verifiedThroughSeq: number
  /** False when later live log facts superseded the captured cut during verification. */
  readonly current: boolean
}
```

## WorkAcceptRequest

```ts type-equiv
/** Explicit acceptance request; caller identity is established by the Host carrier. */
interface WorkAcceptRequest { readonly reviewRevision: number }
```

## WorkAcceptReceipt

```ts type-equiv
/** Durable acceptance receipt, without changing goal or execution state. */
interface WorkAcceptReceipt {
  readonly reviewedThroughSeq: number
  readonly recordedSeq: number
  /** Whether the reviewed prefix is still current after its durability barrier. */
  readonly current: boolean
}
```

## WorkLibraryRevision

```ts type-equiv
/** Opaque identity of the ordered Session corpus and normalized query. */
type WorkLibraryRevision = Branded<'work-library-revision'>
```

## WorkLibraryRequest

```ts type-equiv
/** Bounded scan request over existing Session logs. */
interface WorkLibraryRequest {
  readonly query?: string
  readonly corpusRevision?: WorkLibraryRevision
  readonly sessionOffset?: number
  readonly pathOffset?: number
  readonly limit?: number
}
```

## WorkLibraryEntry

```ts type-equiv
/** One output and its authoritative source Session. */
interface WorkLibraryEntry {
  /** Exact Session cut at which this path inventory was observed. */
  readonly sourceThroughSeq?: number
  readonly sessionId: import('@relay-harness/rlh-session/types').SessionId
  readonly path: string
  readonly cwd?: string
}
```

## WorkLibraryPage

```ts type-equiv
/** Explicit coverage and continuation for one bounded Library scan. */
interface WorkLibraryPage {
  /** Exact ids observed on this page, enabling deduplicated accumulated coverage. */
  readonly observedSessionIds?: readonly import('@relay-harness/rlh-session/types').SessionId[]
  /** Bounded retained observation, never a claim about every current device file. */
  readonly coverage?: { readonly scope: 'observed-corpus'; readonly snapshotId: WorkLibraryRevision; readonly omittedSessions: number }
  readonly entries: readonly WorkLibraryEntry[]
  readonly scannedSessions: number
  readonly totalSessions: number
  readonly unindexedResults: number
  readonly unavailableSessions: number
  readonly next: { readonly sessionOffset: number; readonly pathOffset: number; readonly corpusRevision: WorkLibraryRevision } | null
}
```

## WorkOpenRequest

```ts type-equiv
/** Exact output to open; paths must belong to the addressed source log. */
interface WorkOpenRequest {
  readonly sessionId: import('@relay-harness/rlh-session/types').SessionId
  readonly path: string
}
```

## WorkContentVersion

```ts type-equiv
/** What was actually read: environment, source, locator, hash and observation time. */
interface WorkContentVersion {
  readonly execution: WorkContentExecution
  readonly source: WorkContentSource
  /** Execution-recorded locator the bytes were read from. */
  readonly locator: string
  readonly contentHash: { readonly algorithm: 'sha256'; readonly digest: string }
  /** Non-negative epoch milliseconds when the bytes were read. */
  readonly observedAt: number
}
```

## WorkCheckRecord

```ts type-equiv
/** One checker execution attached to a content review; facts, not success claims. */
interface WorkCheckRecord {
  readonly checkId: WorkCheckId
  readonly checker: { readonly name: string; readonly version?: string; readonly configDigest?: string }
  /** Content-version digests consumed; each must resolve in the owning review. */
  readonly contentVersionRefs: readonly string[]
  readonly exitCode?: number
  readonly verdict: 'pass' | 'fail' | 'unknown'
  /** Durable location of the checker's own output, when captured. */
  readonly log?: { readonly sessionId: import('@relay-harness/rlh-session/types').SessionId; readonly seq: number }
  readonly evidence: WorkCheckEvidence
}
```

## WorkContentReview

```ts type-equiv
/** A user decision bound to explicit content versions and check records — never to a log prefix. */
interface WorkContentReview {
  readonly reviewId: WorkContentReviewId
  readonly decision: WorkContentDecision
  /** All observed versions this review carries. */
  readonly contentVersions: readonly WorkContentVersion[]
  /** Version digests the decision applies to; each must resolve in `contentVersions`. */
  readonly contentVersionRefs: readonly string[]
  readonly checkRecords: readonly WorkCheckRecord[]
  /** Check ids the decision relies on; each must resolve in `checkRecords`. */
  readonly checkRecordRefs: readonly string[]
  readonly actor: 'host-client'
  /** Non-negative epoch milliseconds when the Host recorded the review. */
  readonly reviewedAt: number
}
```

## WorkContentCurrency

```ts type-equiv
/** Honest confirmed-vs-current state of one confirmed version. */
type WorkContentCurrency =
  | { readonly ref: string; readonly state: 'matches-confirmed' }
  | { readonly ref: string; readonly state: 'changed-unreviewed'; readonly current: WorkContentVersion }
  | { readonly ref: string; readonly state: 'not-reverified' }
```

## WorkContentReviewRead

```ts type-equiv
/** Latest durable content review plus its read-side confirmed-vs-current comparison. */
interface WorkContentReviewRead {
  readonly review: WorkContentReview | null
  readonly currency: readonly WorkContentCurrency[]
}
```

## WorkContentReviewRequest

```ts type-equiv
/** Explicit content review submission; caller identity is established by the Host carrier. */
interface WorkContentReviewRequest {
  readonly decision: WorkContentDecision
  readonly contentVersions: readonly WorkContentVersion[]
  readonly contentVersionRefs: readonly string[]
  readonly checkRecords: readonly WorkCheckRecord[]
  readonly checkRecordRefs: readonly string[]
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxworkresults--workresultsservice"></a>

### `ctx.workResults` — `WorkResultsService`

Stateless business adapter; accepted versions and file inventories remain log projections.

```ts cordis-catalog
/** Read independent Work facts without resolving or resuming a live Agent.
 * @param request - Exact source Session address.
 * @param signal - Trusted request cancellation.
 * @returns Orthogonal goal, execution, coverage and action observations.
 */
@Remote('inspect') async inspect(request: WorkReadRequest, signal: AbortSignal): Promise<WorkView>

/** Read final message text without recovering execution or claiming a lease.
 * @param request - Source Session and bounded backward page.
 * @param signal - Trusted request cancellation.
 * @returns An immutable source cut, not a live conversation.
 */
@Remote('history') async history(request: WorkHistoryRequest, signal: AbortSignal): Promise<WorkHistoryPage>

/** Verify a record without the Remote Agent resolver's implicit activation.
 * @param request - Exact Session identity.
 * @param signal - Request cancellation across persistence reads.
 * @returns The existing receipt semantics; a cold Session explicitly cannot be confirmed.
 */
@Remote('review') async review(request: WorkReadRequest, signal: AbortSignal): Promise<WorkVerifiedReview>

/**
 * Read the exact review prefix without changing goal or task state.
 * @param agent - addressed live agent resolved by the existing Remote lookup.
 * @param signal - cancellation through the captured durability verification.
 * @returns the captured review cut and only its physically verified receipt.
 */
@Remote('get') async get(agent: Agent, signal: AbortSignal): Promise<WorkVerifiedReview>

/**
 * Record explicit user acceptance after final quiescence and revision checks.
 * @param agent - exact live runtime root being reviewed.
 * @param request - expected non-acceptance log revision shown to the user.
 * @param signal - trusted carrier cancellation, never a wire argument.
 * @returns a receipt only after durability; later work makes its current flag false.
 */
@Remote('accept') async accept(agent: Agent, request: WorkAcceptRequest, signal: AbortSignal): Promise<WorkAcceptReceipt>

/**
 * Scan a bounded page of existing Session logs without activating any agent.
 * @param request - filename query, pagination position, and result bound.
 * @param signal - cancellation between bounded non-activating reads.
 * @returns source-attributed outputs and explicit scan/incomplete-history coverage.
 */
@Remote('list') async list(request: WorkLibraryRequest, signal: AbortSignal): Promise<WorkLibraryPage>

/**
 * Read the latest explicit content review with its confirmed-vs-current comparison.
 * @param request - exact source Session address.
 * @param signal - cancellation through the non-activating source read.
 * @returns The latest review and per-version currency; the Host performs no fresh
 * re-reads, so every confirmed version reads `not-reverified` until a caller with a
 * fresh observation applies {@link contentCurrency}.
 */
@Remote('contentReview') async contentReview(request: WorkReadRequest, signal: AbortSignal): Promise<WorkContentReviewRead>

/**
 * Record an explicit user content review bound to versions and check records, never to a log prefix.
 * @param agent - exact live Session receiving the durable `work/reviewed` event.
 * @param request - decision, observed content versions and check records.
 * @param signal - trusted carrier cancellation through the durability barrier.
 * @returns the recorded review; a byte-identical resubmission reuses the latest record.
 */
@Remote('recordContentReview') async recordContentReview(agent: Agent, request: WorkContentReviewRequest, signal: AbortSignal): Promise<WorkContentReview>

/**
 * Validate a captured output against its source Session and open it on the Host.
 * @param request - source Session identity and exact execution-recorded path.
 * @param signal - carrier cancellation through native-open completion.
 * @returns after the existing native-open operation succeeds.
 */
@Remote('open') async open(request: WorkOpenRequest, signal: AbortSignal): Promise<void>
```

Types: [Agent](core.md)

Source: [`packages/host/work-results/src/index.ts:55`](../../packages/host/work-results/src/index.ts)
<!-- END GENERATED cordis-surface -->
