# Context Engine

English | [中文](context-engine.zh.md)

The local context-engine seam: a step-context contributor registry the AgentLoop consults between inbox claim and prompt assembly, plus the evidence, coverage, and provider-observability vocabulary that contributors and knowledge-provider adapters exchange. Design authority lives in the Relay root repository (`docs/adr/0006-local-context-engine.md`, ADR-0006, and `docs/agent/context-engine.md`); this page projects the harness-side contracts.

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

`ContextEngineService.registerContributor` reserves a unique contributor id atomically; `prepareStep` runs every contributor once per claimed step, in registration order, with the claimed messages, the step's abort signal, and the session-header working directory. Contributed messages append to the step's user messages and are recorded as durable `user/message` events; a step without contributions is byte-identical to a deployment without the service.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcontextengine--contextengineservice"></a>

### `ctx.contextEngine` — `ContextEngineService`

`ctx.contextEngine`. Owns the contributor registry and the step preparation call; retrieval planning, hydration, and packing enrich `prepareStep` inside implementations of this seam.

```ts cordis-catalog
/**
 * Register one step-context contributor.
 * @param contributor - the contributor with a unique non-empty id.
 * @returns a disposer removing the registration.
 */
registerContributor(contributor: StepContextContributor): () => void

/**
 * Prepare the step context for one claimed step.
 * @param input - the claimed messages and abort signal.
 * @returns the collected context, or `undefined` when no contributor produced any.
 */
prepareStep(input: StepContextInput): Promise<PreparedStepContext | undefined>
```

Source: [`packages/context/context-engine/src/types.ts:203`](../../packages/context/context-engine/src/types.ts)
<!-- END GENERATED cordis-surface -->
