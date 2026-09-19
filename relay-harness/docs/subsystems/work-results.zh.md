# Work 记录与 Library

[English](work-results.md) | 中文

[Work Results adapter](../../packages/host/work-results/README.md) 拥有日志前缀确认与有界的跨会话交付物发现能力。Session 日志仍为权威来源，不另建 Work 数据库。回执记录可信 Host 客户端的显式确认，不是文件摘要、测试结果或权限授予。

已验证读取与成功确认响应要求对应日志前缀已持久化。原始投影可以使显示的确认失效，但不能证明持久化完成。打开记录中的产物时，授权由既有 Host opener 决定；来源归属不授予访问权限。

显式内容审核与日志前缀确认相互独立：`work/reviewed` 事件把用户决定绑定到声明的内容版本摘要和检查记录，绝不绑定日志前缀；读取在真正重读之前报告 `not-reverified` currency。既有 `work/accepted` 语义保持不变。

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
  readonly sessionId: import('@relay-harness/rlh-session/types').SessionId
  readonly path: string
  readonly cwd?: string
}
```

## WorkLibraryPage

```ts type-equiv
/** Explicit coverage and continuation for one bounded Library scan. */
interface WorkLibraryPage {
  readonly entries: readonly WorkLibraryEntry[]
  readonly scannedSessions: number
  readonly totalSessions: number
  readonly unindexedResults: number
  readonly unavailableSessions: number
  readonly next: { readonly sessionOffset: number; readonly pathOffset: number; readonly corpusRevision: WorkLibraryRevision } | null
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
 * Validate a captured output against its source Session and open it on the Host.
 * @param request - source Session identity and exact execution-recorded path.
 * @param signal - carrier cancellation through native-open completion.
 * @returns after the existing native-open operation succeeds.
 */
@Remote('open') async open(request: WorkOpenRequest, signal: AbortSignal): Promise<void>
```

Types: [Agent](core.md)

Source: [`packages/host/work-results/src/index.ts:37`](../../packages/host/work-results/src/index.ts)
<!-- END GENERATED cordis-surface -->
