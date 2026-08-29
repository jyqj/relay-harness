# @relay-harness/rlh-context-engine

English | [中文](README.zh.md)

Service Definition and deterministic control-plane implementation of the local context engine seam (`ctx.contextEngine`): purpose eligibility, provider-local retrieval deadlines and allowances, whole-message packing, decision tracing, plus the evidence, coverage, and provider-observability vocabulary that contributors and knowledge-provider adapters exchange. Design authority: Relay root repository `docs/adr/0006-local-context-engine.md` (ADR-0006) and `docs/agent/context-engine.md`.

AgentLoop calls the seam between inbox claim and prompt assembly (see [architecture turn flow](../../../docs/architecture.md#turn-flow)); selected messages append to the step's user messages and are recorded as durable `user/message` events. On an accepted step, AgentLoop also records one log-only `context/prepared` trace after those messages and before the model request. The trace keeps the resolved plan, selected/rejected decisions, contributor attribution, JSON-safe evidence, coverage, and exact message-event seq links; it does not duplicate transcript content. A request in which every eligible contributor declines returns `undefined`; a timeout, disposed generation, duplicate, or budget rejection returns a rejection-only preparation so the accepted step records why no context was injected.

## Service API (`ctx.contextEngine`)

| Member | Semantics |
|---|---|
| `registerContributor(contributor)` | Atomically reserve a unique non-empty contributor id; an invalid or duplicate registration publishes nothing and throws `ContextEngineError` (`CONTEXT_ENGINE_INVALID_CONTRIBUTOR` / `CONTEXT_ENGINE_CONFLICT`). Returns a disposer removing exactly that registration. |
| `prepareStep(input)` | Resolve purpose eligibility and local allowances, run each eligible contributor with a child abort signal and deadline, then rank explicit references before provider discoveries for budget selection and duplicate suppression. Selected messages retain registration order. The immutable result carries the plan, decisions, attributed contributions, messages, evidence, and coverage. Malformed payloads, empty/intra-candidate Evidence ids, or duplicate Evidence ids across selected candidates fail atomically. Returns `undefined` only when every eligible contributor declines and no rejection needs recording. |

The planner is deterministic and does not call a model. `StepContextContributor.purposes` declares provider eligibility; omission supports every purpose. Each eligible provider receives `StepContextInput.budget` with local character/token ceilings, timeout, and absolute deadline. Providers retain their own retrieval algorithms and should clip within that allowance. A timed-out child signal does not abort the parent request, so later providers still run; a late result from a timed-out or disposed registration generation is ignored. The parent request signal still aborts the complete preparation atomically.

## Configuration

| Field | Default | Meaning |
|---|---:|---|
| `maxChars` | `64000` | Total selected Unicode code points. |
| `maxTokens` | `16000` | Total selected tokens under `ctx.tokenMeter`, or the engine's deterministic fallback estimator when the meter is absent. |
| `maxContributorChars` | `64000` | Per-provider character ceiling. |
| `maxContributorTokens` | `16000` | Per-provider token ceiling. |
| `contributorTimeoutMs` | `5000` | Per-provider wall-clock deadline; timeout aborts only that provider read. |

## Vocabulary

`ContextRetrievalPlan` records purpose eligibility and resolved total/local budgets before providers run. `ContextCandidateDecision` records `selected` or `rejected` with stable reasons such as `timeout`, `disposed`, `duplicate`, and the character/token budget that rejected a candidate. `ContextCandidateSelection` lets explicit file, code-path, or MCP Resource references outrank provider-discovered recall without moving retrieval into the engine. `ResourceRef`, `Evidence`, `CoverageRecord`, `NegativeFinding`, and provider health/generation/explain types retain their provider-neutral meanings. All types are documented in [`src/types.ts`](src/types.ts) and projected in [docs/subsystems/context-engine.md](../../../docs/subsystems/context-engine.md).

## Model Experience

None, as this trusted seam registers no model-facing prompt, schema, tool, or message of its own; contributors own their message sources, and the engine only sequences and records what they contribute.

#### KV Cache effect

Indirect and contributor-owned; contributed messages append after the claimed user messages, following the reusable request prefix, so injection does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Sequential provider reads** — deadlines prevent one uncooperative provider from blocking later reads, but eligible providers run in registration order rather than parallel fan-out.
- **Whole-message packing** — providers clip/hydrate their own results under the local allowance; the engine rejects an oversized contribution rather than slicing provider-owned message/evidence correspondence.
- **Provider coverage is partial** — shipped file-reference, local-code-index, long-term-memory, Prompt-specific Session History, and MCP Resource contributors produce Evidence; general session-query and LSP providers remain deferred.
- **Hydration policy remains provider-local** — the engine verifies JSON durability and evidence identity while each source provider owns current-source read, revision comparison, and content digest verification.
