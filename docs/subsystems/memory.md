# Long-Term Memory

English | [中文](memory.zh.md)

Long-term memory stores governed knowledge across Agent sessions without replacing the append-only SessionEvent evidence that produced it. [`@deepseek-ai/dsh-memory`](../../packages/memory/memory) owns the provider-neutral types and `ctx.longTermMemory`; [`memory-sqlite`](../../packages/memory/memory-sqlite) is the shipped local provider; [`memory-agent`](../../packages/memory/memory-agent) and [`tool-memory`](../../packages/memory/tool-memory) are independent Consumers.

## Scope and identity

Every operation supplies one exact `MemoryScope`: workspace, user, and stable Agent identity. Session ids are evidence and turn-settlement identities, not long-term Scope; sessions with the same Scope may recall one another. The standard preset derives workspace from the session cwd, uses the local OS user name, and fixes the Agent id to `deepseek-harness`.

`MemoryId` identifies one logical memory. `revision` increases while the id remains stable. The provider retains each complete revision and separately materializes the current entry and its recall indexes.

## Kinds, status, and trust

Kinds distinguish preferences, facts, constraints, decisions, procedures, and lessons. Project and user identity belong in Scope rather than the kind; live task state remains outside memory.

Status is `candidate`, `active`, `disputed`, `superseded`, or `tombstoned`. Proactive recall reads only unexpired active entries. An active entry requires `user-stated` or `action-verified` trust with matching durable evidence. Agent proposals and external observations remain candidates or disputed until another trusted Consumer reviews them.

## Evidence and revisions

Each write cites a Session id and non-empty earlier event seqs. User-stated evidence names a direct user message; action-verified evidence names a successful tool result and its call. A revision never replaces or deletes its predecessors. Forgetting appends a tombstone and removes the current entry from FTS while preserving exact-id audit reads.

The model tools enforce exact evidence excerpts before requesting active state, and the provider repeats trust/evidence and secret checks so another Consumer cannot bypass the decision.

## Recall lifecycle

The Agent Consumer prepares candidates during the first `agent/pre-step`, after downstream listeners accept the direct message. It serializes retained entries as untrusted JSON in a separately sourced `user/message`, so the Session log reconstructs the exact model request. The complete message is character-bounded. Provider failure fails open without modifying the direct prompt.

The prepared handle remains open until final `turn/end`. Completed and max-token turns commit the exact ids that entered the model request; error, abort, interruption, missing Assistant output, replacement, or unload aborts it. The SQLite provider stores the settlement idempotently and records candidate-hit and injected signals.

Recall-form user messages remain in the raw session log but contribute no Session Query semantic document. This prevents recalled memory or referenced-session snapshots from becoming fresh episodic evidence and recursively amplifying themselves.

## SQLite retrieval

The local provider maintains Unicode and trigram FTS5 indexes over current non-tombstoned entries. It fuses channel ranks, then applies bounded importance and trust weights. Queries and every metadata filter are SQL parameters; caller Scope is mandatory. The canonical database rejects unrelated files and unknown schema versions instead of resetting them.

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
 * Search current entries inside an exact scope.
 * @param input - normalized query, filters, and result cap.
 * @param signal - cancellation for the read.
 * @returns ranked current entries with retrieval-channel evidence.
 */
abstract search(input: SearchMemoryInput, signal?: AbortSignal): Promise<readonly MemorySearchHit[]>
```

Source: [`packages/memory/memory/src/index.ts:51`](../../packages/memory/memory/src/index.ts)
<!-- END GENERATED cordis-surface -->
