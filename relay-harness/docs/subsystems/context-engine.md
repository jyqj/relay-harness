# Context Engine

English | [中文](context-engine.zh.md)

The local context-engine seam: a purpose-tagged context-contributor registry used by AgentLoop and Prompt Enhancement, plus the evidence, coverage, and provider-observability vocabulary that contributors and knowledge-provider adapters exchange. Design authority lives in the Relay root repository (`docs/adr/0006-local-context-engine.md`, ADR-0006, and `docs/agent/context-engine.md`); this page projects the harness-side contracts.

Sources: [`packages/context/context-engine/src/types.ts`](../../packages/context/context-engine/src/types.ts) · [`packages/context/context-engine/src/index.ts`](../../packages/context/context-engine/src/index.ts)

## Resource addressing and evidence

`ResourceRef` addresses one resource as a source id plus an opaque source-local key and revision. Revisions are opaque to the engine: a file tree uses stat identities, a session corpus uses event seqs, a memory scope uses revision numbers. An omitted revision means explicitly unknown, never "any revision".

`Evidence` is one admitted observation bound to that revision, with an optional content digest, a truncation flag, freshness, and a verification outcome. `unverified` is an explicit state, not a default: mechanical verification (digest and revision agreement) is an admission-time check, while semantic verification runs only under an explicit obligation.

```ts type-equiv
/**
 * One addressable resource inside a registered source. `key` and `revision` are opaque to the
 * engine: a file tree uses paths and stat identities, a session corpus uses ids and event seqs,
 * a memory scope uses entry ids and revision numbers.
 */
interface ResourceRef {
  /** The source that owns and addresses the resource. */
  readonly sourceId: SourceId
  /** Source-local opaque resource key (never a bare cross-source path). */
  readonly key: string
  /** Source-local opaque revision; omitted marks `revision unknown`, never "any revision". */
  readonly revision?: string
}
```

## Retrieval coverage and negative findings

`CoverageRecord` names what a retrieval actually inspected: the scopes searched, the scopes deliberately skipped and why, and a completeness classification. `NegativeFinding` carries one negative claim with the scopes checked to support it; an empty `checked` list is invalid because a negative claim without inspected scopes is not assertable.

```ts type-equiv
/**
 * What a retrieval actually inspected: the scopes searched, the scopes deliberately skipped and
 * why, and the completeness classification. A zero-hit result without a coverage record reads as
 * "not found here", never as "does not exist".
 */
interface CoverageRecord {
  /** Scopes actually inspected (directories, sources, patterns), as specific as available. */
  readonly searched: readonly string[]
  /** Scopes a consumer might expect to be covered but were deliberately skipped. */
  readonly notSearched: readonly string[]
  /** One-sentence justification of the searched/not-searched split. */
  readonly rationale?: string
  /** Completeness classification of the inspection. */
  readonly completeness: CoverageCompleteness
}
```

## Provider observability

`ProviderHealthState`, `ProviderGeneration`, and `ProviderExplain` are the health and degradation surface knowledge-provider adapters report. The generation pair is a two-clock cache key — index content commits advance `indexEpoch`, runtime-evidence ingestion alone advances `evidenceEpoch` — and `ProviderExplain.truncatedReason` is a stable token (`output_budget`, `default_limit`, `max_depth`, `db_error:<op>`, …), never free text, so consumers can assert on it.

```ts type-equiv
/**
 * Two-clock generation of one knowledge provider's index: `indexEpoch` advances on index-content
 * commits, `evidenceEpoch` only on runtime-evidence ingestion, so evidence writes do not
 * invalidate index-only caches. Consumers compare the pair as a cache key.
 */
interface ProviderGeneration {
  /** Generation of index content (file batches, graph rebuilds, full rebuilds). */
  readonly indexEpoch: number
  /** Generation of runtime-evidence ingestion alone. */
  readonly evidenceEpoch: number
}
```

## Step-context seam

`ContextEngineService.registerContributor` reserves a unique contributor id atomically. `prepareStep` resolves a deterministic plan from the request purpose and each contributor's declared purposes, assigns local character/token/deadline allowances, and runs eligible providers in registration order with isolated child abort signals. Explicit-reference candidates rank before provider-discovered recall for duplicate suppression and total-budget selection; selected messages return to registration order. `StepContextCaller` supplies session/Agent/workspace identity, optional owning turn/step, effective preset, and origin without exposing a live Agent object. Before publication the engine detaches, lossless-JSON validates, and freezes provider-owned contributions. A parent abort fails atomically, while a timeout or disposed registration generation ignores the late result and continues later providers. Providers retain retrieval and hydration policy; the engine owns eligibility, budgets, packing, and decision trace.

## Durable preparation trace

AgentLoop owns the accepted step and therefore owns durability: after appending admitted `user/message` events and before dispatching the model request, it appends one log-only `context/prepared` event. The event retains the plan, selected/rejected decisions, and each selected contribution's evidence, optional coverage, proposed message id, and structurally exact admitted message seqs. A rejection-only trace records timeout, disposal, duplicate, or budget outcomes without adding model-visible content. The invariant requires links to lie inside the exact open step and rejects empty unaccounted or late traces. `Evidence.domain` is `JsonValue`; ContextEngine validates it before admission and `Session.append` remains the final durable boundary. The trace contains no copy of message content and never participates in `deriveMessages()`.

```ts type-equiv
/**
 * One durable context-preparation fact, appended by AgentLoop after the accepted step's messages
 * and before its model request. Messages remain reconstructable from `user/message`; this record
 * carries attribution, evidence, coverage, and admission links without becoming a second transcript.
 */
interface ContextPreparedEventData {
  /** Owning turn. */
  readonly turn: number
  /** Owning step. */
  readonly step: number
  /** Prepared contributions in registry order. */
  readonly contributions: readonly ContextPreparedContributionTrace[]
  /** Deterministic provider eligibility and budget plan. */
  readonly plan: ContextRetrievalPlan
  /** Selected and rejected packing outcomes. */
  readonly decisions: readonly ContextCandidateDecision[]
}
```


## Context Inspector product surface

The `contextInspector` Session Projection folds the complete durable log, not the browser paging window. It retains the latest 50 `context/prepared` traces and links each contributor to exact admitted `user/message` seqs; empty links remain visible as rejected or rewritten proposals. Evidence source/path/revision, freshness, verification, truncation, provider why-used reasons, searched/not-searched scopes, rationale, and completeness reach the browser drawer through the standard projection channel. The additive conversation-header utility opens the drawer without changing Chat nodes or model-visible messages.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcontextengine--contextengineservice"></a>

### `ctx.contextEngine` — `ContextEngineService`

`ctx.contextEngine`. Owns contributor registration, deterministic planning, and packing.

```ts cordis-catalog
/**
 * Register one step-context contributor.
 * @param contributor - the contributor with a unique non-empty id.
 * @returns a disposer removing the registration.
 */
registerContributor(contributor: StepContextContributor): () => void

/**
 * Prepare context for one purpose-tagged request.
 * @param input - purpose, messages, parent abort signal, working directory, and caller identity.
 * @returns selected context and its decision trace, or `undefined` when every provider declines.
 */
prepareStep(input: ContextPrepareInput): Promise<PreparedStepContext | undefined>
```

Source: [`packages/context/context-engine/src/types.ts:386`](../../packages/context/context-engine/src/types.ts)

<a id="ctxsessionhistorycontext--sessionhistorycontext"></a>

### `ctx.sessionHistoryContext` — `SessionHistoryContext`

Host service that owns the contributor registration and resolved policy.

Source: [`packages/context/session-history-context/src/index.ts:94`](../../packages/context/session-history-context/src/index.ts)
<!-- END GENERATED cordis-surface -->
