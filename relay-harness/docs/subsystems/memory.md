# Long-Term Memory

English | [中文](memory.zh.md)

Long-term memory stores governed knowledge across Agent sessions without replacing the append-only SessionEvent evidence that produced it. [`@relay-harness/rlh-memory`](../../packages/memory/memory) owns the provider-neutral `ctx.longTermMemory` and `ctx.memoryExtractionQueue` seams; [`memory-sqlite`](../../packages/memory/memory-sqlite) is the shipped single owner; [`memory-agent`](../../packages/memory/memory-agent), [`memory-extractor-llm`](../../packages/memory/memory-extractor-llm), and [`tool-memory`](../../packages/memory/tool-memory) are independent Consumers.

## Scope and identity

Every operation supplies one exact `MemoryScope`: workspace, user, and stable Agent identity. Session ids are evidence and turn-settlement identities, not long-term Scope; sessions with the same Scope may recall one another. The standard preset derives workspace from the session cwd, uses the local OS user name, and fixes the Agent id to `relay-harness`.

`MemoryId` identifies one logical memory. `revision` increases while the id remains stable. The provider retains each complete revision and separately materializes the current entry and its recall indexes.

## Kinds, status, and trust

Kinds distinguish preferences, facts, constraints, decisions, procedures, and lessons. Project and user identity belong in Scope rather than the kind; live task state remains outside memory.

Status is `candidate`, `active`, `disputed`, `superseded`, or `tombstoned`. Proactive recall reads only unexpired active entries. An active entry requires `user-stated` or `action-verified` trust with matching durable evidence. Agent proposals and external observations remain candidates or disputed until another trusted Consumer reviews them.

## Evidence and revisions

Each write cites a Session id and non-empty earlier event seqs. User-stated evidence names a direct user message; action-verified evidence names a successful tool result and its call. A revision never replaces or deletes its predecessors. Forgetting appends a tombstone and removes the current entry from FTS while preserving exact-id audit reads.

The model tools enforce exact evidence excerpts before requesting active state, and the provider repeats trust/evidence and secret checks so another Consumer cannot bypass the decision.

## Context Provider and recall lifecycle

The host-owned `memory-agent` registers one Context Engine contributor. `StepContextInput.caller` carries detached durable session, turn/step, workspace, origin, and effective preset identity; the shipped policy admits `standard` top-level sessions. On the first Agent step, the contributor prepares candidates from direct user text, serializes retained entries as untrusted JSON, and returns a separately sourced message together with revision-bound Memory Evidence and bounded coverage. AgentLoop records the admitted message and the exact Evidence/proposal admission relationship in `context/prepared`. Provider failure fails open without modifying the direct prompt.

The prepared handle remains open until final `turn/end`. Completed and max-token turns commit only ids whose exact proposal survived `agent/pre-step` according to the durable trace; a removed or rewritten proposal commits no injected ids. Error, abort, interruption, missing Assistant output, replacement, unload, or failure between provider prepare and pending ownership aborts the handle. Evidence digest covers the complete injected item payload. The SQLite provider stores settlement idempotently and records candidate-hit and injected signals.

For Prompt Enhancement the same contributor performs an active, unexpired, exact-Scope search under the same character budget and provenance format. It passes `recordAccess: false` and never calls prepare/commit/abort, so previewing an unsent draft mutates neither memory counters/turn state nor the target Session log.

Recall-form user messages remain in the raw session log but contribute no Session Query semantic document. This prevents recalled memory or referenced-session snapshots from becoming fresh episodic evidence and recursively amplifying themselves.

## Automatic extraction lifecycle

Automatic extraction is a host Consumer rather than hidden Agent-loop mutation. Its package default is off; the shipped base composition explicitly enables it only for sessions carrying the durable `standard` preset identity and excludes subagents. On completed or max-token `turn/end`, capture projects direct user messages and successful tool results only. Derived recall/plugin messages, reasoning, failed results, memory/session/skill tool outputs, and secret-bearing sources are excluded before persistence.

The bounded source snapshot and auxiliary route enter an idempotent durable job keyed by Scope, session, turn, and source hash. SQLite atomically claims the oldest available job, persists attempts and an expiring lease, reclaims interrupted work, retries malformed/model/provider failures, and records completed or terminal state across restart. A completed result retains only memory ids, counts, and the model-output hash; raw model output is not another truth source.

The auxiliary call uses `purpose: 'memory-extraction'`, a fixed JSON-only instruction, no tools, and no conversation history. Proposals are parsed strictly. An exact contiguous quote from a direct user source becomes user-stated active memory; an exact quote from an allowlisted successful local-tool result becomes action-verified active memory. Active automatic content is the exact quote, not the model paraphrase. Successful non-allowlisted observations and ungrounded proposals remain candidates. Provider-side trust, evidence, Scope, secret, and exact-dedup checks remain authoritative on every retry.

## SQLite retrieval

The local provider maintains Unicode and trigram FTS5 indexes over current non-tombstoned entries. It fuses channel ranks, then applies bounded importance and trust weights. Queries and every metadata filter are SQL parameters; caller Scope is mandatory. `SearchMemoryInput.recordAccess` defaults true, while a false auxiliary preview is read-only. The canonical database rejects unrelated files and unknown schema versions instead of resetting them. Schema version 2 adds deterministic content hashes and extraction jobs; version 3 adds the single-owner heartbeat table. Earlier stores migrate in place.

## Memory Center and remaining gaps

The shipped Web composition now mounts a governed Memory Center. Every paged list/search/read is authorized by an attached Host Session whose cwd must match the Client workspace scope; recall accounting remains unchanged. Candidate/disputed approve or reject, user-evidenced revision, and tombstone deletion carry the displayed revision. The Client cache and Settings UI expose every canonical status, source excerpts, `validUntil` freshness, explicit supersession links, and cross-session why-used occurrences with current/historical revision state. Governance writes append `memory/governance-requested`, require Session durability, and recheck revision before the provider write; the browser cannot invent an active user-stated memory or overwrite newer governance.

Memory Center now scans the complete same-workspace Session Query corpus without activating Agents and labels failed reads as partial coverage. Its generation-keyed Client cache rejects stale in-flight fills, and multi-page substring search restarts when concurrent revisions reorder page boundaries. Canonical signals expose retrieval, injection, user confirmation, and user rejection. Candidate review runs deterministic normalized content/summary collision detection before consulting an optional attributed semantic detector. SQLite version 4 stores idempotent per-Session outcomes; explicit Assistant ratings and durable Work completion produce bounded ranking impact, while ordinary recall, turn completion/failure, and blocked Work remain neutral. Feedback unavailability preserves the last durable outcomes, and failed full reconciliation is retryable. No physical retention policy was added: expiry stays visible and tombstones preserve history.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxlongtermmemory--longtermmemory-abstract-seam"></a>

### `ctx.longTermMemory` — `LongTermMemory` (abstract seam)

Service Definition for durable write governance and cross-session recall.

```ts cordis-catalog
/**
 * Prepare one immutable recall observation before a host turn enters the log.
 * @param input - exact scope, host identity, query, and candidate cap.
 * @param signal - cancellation for the active host turn.
 * @returns provider handle and ranked candidates retained until settlement.
 */
abstract prepare(input: PrepareMemoryTurnInput, signal: AbortSignal): Promise<PreparedMemoryTurn>

/**
 * Commit the exact candidates made model-visible by a successful host turn.
 * @param input - prepared observation and admitted candidate identities.
 * @returns after the provider durably settles the prepared turn.
 */
abstract commit(input: CommitMemoryTurnInput): Promise<void>

/**
 * Abort a prepared turn that never reached a successful host settlement.
 * @param input - prepared observation and stable host-owned reason.
 * @returns after the provider durably settles the prepared turn.
 */
abstract abort(input: AbortMemoryTurnInput): Promise<void>

/**
 * Append the first revision of one governed memory.
 * @param input - scoped content, classification, trust, and durable evidence.
 * @param signal - cancellation for the write.
 * @returns the committed current entry.
 */
abstract remember(input: RememberMemoryInput, signal?: AbortSignal): Promise<MemoryEntry>

/**
 * Append a replacement revision without mutating prior evidence.
 * @param input - scoped identity, changed fields, and new evidence.
 * @param signal - cancellation for the write.
 * @returns the committed current entry.
 */
abstract revise(input: ReviseMemoryInput, signal?: AbortSignal): Promise<MemoryEntry>

/**
 * Append a tombstone and remove the entry from recall indexes.
 * @param input - scoped identity, reason, and durable evidence.
 * @param signal - cancellation for the write.
 * @returns the committed tombstoned entry.
 */
abstract forget(input: ForgetMemoryInput, signal?: AbortSignal): Promise<MemoryEntry>

/**
 * Read one current entry inside an exact scope.
 * @param scope - exact recall partition.
 * @param id - logical memory identity.
 * @param signal - cancellation for the read.
 * @returns current entry, or undefined when absent from this scope.
 */
abstract read(scope: MemoryScope, id: MemoryId, signal?: AbortSignal): Promise<MemoryEntry | undefined>

/**
 * List the provider's current materialized entries for one exact scope.
 * Unlike recall search, this governance read can include expired, superseded, and tombstoned
 * entries and never changes retrieval-use accounting.
 * @param input - exact scope, filters, and deterministic page window.
 * @param signal - cancellation for the read.
 * @returns one newest-first page and the matching total.
 */
abstract list(input: ListMemoryInput, signal?: AbortSignal): Promise<MemoryListPage>

/**
 * Find deterministic normalized-key conflicts in one exact scope.
 * @param input - target identity and result cap.
 * @param signal - cancellation for the read.
 * @returns duplicate or summary-collision candidates.
 */
abstract findConflicts( input: FindMemoryConflictsInput, signal?: AbortSignal, ): Promise<readonly MemoryConflictCandidate[]>

/**
 * Read canonical retrieval and user-governance signals.
 * @param scope - exact recall partition.
 * @param id - logical memory identity.
 * @param signal - cancellation for the read.
 * @returns chronological signal history.
 */
abstract listSignals(scope: MemoryScope, id: MemoryId, signal?: AbortSignal): Promise<readonly MemorySignal[]>

/**
 * Atomically replace one Session's reconciler-owned outcome observations.
 * @param input - exact scope, Session, and complete derived outcome set.
 * @param signal - cancellation before the write begins.
 * @returns after the canonical outcome view is durable.
 */
abstract reconcileOutcomes(input: ReconcileMemoryOutcomesInput, signal?: AbortSignal): Promise<void>

/**
 * Read recent outcome observations for one memory.
 * @param input - exact scope, identity, and result cap.
 * @param signal - cancellation for the read.
 * @returns newest-first outcome observations.
 */
abstract listOutcomes(input: ListMemoryOutcomesInput, signal?: AbortSignal): Promise<readonly MemoryOutcome[]>

/**
 * Search current entries inside an exact scope.
 * @param input - normalized query, filters, result cap, and optional access-accounting policy.
 * @param signal - cancellation for the read.
 * @returns ranked current entries with retrieval-channel evidence.
 */
abstract search(input: SearchMemoryInput, signal?: AbortSignal): Promise<readonly MemorySearchHit[]>
```

Source: [`packages/memory/memory/src/index.ts:91`](../../packages/memory/memory/src/index.ts)

<a id="ctxmemoryconflictdetector--memoryconflictdetector-abstract-seam"></a>

### `ctx.memoryConflictDetector` — `MemoryConflictDetector` (abstract seam)

Optional semantic detector composed by deployments that can justify richer conflict candidates.

```ts cordis-catalog
/**
 * Detect provider-attributed semantic conflicts without mutating canonical memory.
 * @param input - target plus bounded same-Scope candidates.
 * @param signal - cancellation for optional provider work.
 * @returns attributed conflict candidates only.
 */
abstract detect( input: DetectMemoryConflictsInput, signal?: AbortSignal, ): Promise<readonly MemoryConflictCandidate[]>
```

Source: [`packages/memory/memory/src/index.ts:73`](../../packages/memory/memory/src/index.ts)

<a id="ctxmemoryextractionqueue--memoryextractionqueue-abstract-seam"></a>

### `ctx.memoryExtractionQueue` — `MemoryExtractionQueue` (abstract seam)

Provider-neutral durable queue used by turn capture and extractor workers.

```ts cordis-catalog
/**
 * Idempotently admit one completed-turn source snapshot.
 * @param input - exact Scope, source hash, route, bounded sources, and retry cap.
 * @returns existing or newly committed job for the dedupe identity.
 */
abstract enqueue(input: EnqueueMemoryExtractionInput): Promise<MemoryExtractionJob>

/**
 * Atomically claim the oldest available job or reclaim one whose lease expired.
 * @param input - worker identity, lease duration, and optional deterministic clock.
 * @returns claimed running job, or undefined when none is available.
 */
abstract claim(input: ClaimMemoryExtractionInput): Promise<MemoryExtractionJob | undefined>

/**
 * Commit one successful extraction under the current lease.
 * @param input - job, worker identity, and terminal result.
 * @returns completed job.
 */
abstract complete(input: CompleteMemoryExtractionInput): Promise<MemoryExtractionJob>

/**
 * Settle one failed attempt as pending retry or terminal failed.
 * @param input - job, worker identity, error, and requested retry time.
 * @returns updated job.
 */
abstract fail(input: FailMemoryExtractionInput): Promise<MemoryExtractionJob>

/**
 * Read one job for diagnostics and tests.
 * @param id - durable job identity.
 * @returns current job, or undefined when absent.
 */
abstract read(id: MemoryExtractionJobId): Promise<MemoryExtractionJob | undefined>
```

Source: [`packages/memory/memory/src/extraction.ts:20`](../../packages/memory/memory/src/extraction.ts)

<a id="ctxmemoryoutcomereconciler--memoryoutcomereconciler"></a>

### `ctx.memoryOutcomeReconciler` — `MemoryOutcomeReconciler`

Host service maintaining idempotent Memory outcome observations from durable Session facts.

```ts cordis-catalog
/**
 * Reconcile the complete live-preferred persisted corpus once per process unless explicitly refreshed.
 * @param refresh - force a new full observation after the initial pass.
 * @returns after every readable Session has settled independently.
 */
ensureReconciled(refresh: boolean = false): Promise<void>

/**
 * Reconcile all logical Sessions through Session Query without resuming an Agent.
 * @returns after the bounded worker pool settles all Sessions.
 */
async reconcileAll(): Promise<void>

/**
 * Reconcile one logical Session through the live-preferred non-activating Session Query read.
 * @param sessionId - logical Session identity.
 * @returns after its complete derived outcome set replaces the previous set.
 */
reconcileSession(sessionId: SessionId): Promise<void>
```

Types: [SessionId](core.md)

Source: [`packages/memory/memory-outcome-reconciler/src/index.ts:58`](../../packages/memory/memory-outcome-reconciler/src/index.ts)
<!-- END GENERATED cordis-surface -->
