# @relay-harness/rlh-context-engine

English | [中文](README.zh.md)

Service Definition of the local context engine seam (`ctx.contextEngine`): a step-context contributor registry and one deterministic `prepareStep` pass per claimed agent step, plus the evidence, coverage, and provider-observability vocabulary that contributors and knowledge-provider adapters exchange. Design authority: Relay root repository `docs/adr/0006-local-context-engine.md` (ADR-0006) and `docs/agent/context-engine.md`.

AgentLoop calls the seam between inbox claim and prompt assembly (see [architecture turn flow](../../../docs/architecture.md#turn-flow)); contributed messages append to the step's user messages, are recorded as durable `user/message` events, and a step without contributions is byte-identical to a deployment without the service.

## Service API (`ctx.contextEngine`)

| Member | Semantics |
|---|---|
| `registerContributor(contributor)` | Atomically reserve a unique non-empty contributor id; an invalid or duplicate registration publishes nothing and throws `ContextEngineError` (`CONTEXT_ENGINE_INVALID_CONTRIBUTOR` / `CONTEXT_ENGINE_CONFLICT`). Returns a disposer removing exactly that registration. |
| `prepareStep(input)` | Run every registered contributor, once, in registration order, with the claimed messages, the step's abort signal, and the session-header working directory; concatenate contributed messages and evidence. Returns `undefined` when nothing was contributed. |

Contributors run sequentially by registration order so the packed message order is deterministic and reproducible across restarts; parallel fan-out arrives with the retrieval planner. Working sets and explicit references arrive inside the messages themselves (file mentions, session references), keeping request construction deterministic without a model call.

## Vocabulary

`ResourceRef` addresses one resource as `sourceId` + opaque `key` + optional `revision` (omitted means explicitly unknown, never "any revision"). `Evidence` is one admitted observation bound to that revision, with `digest`, `truncated`, `freshness`, and `verification` — `unverified` is an explicit state, not a default. `CoverageRecord` names what a retrieval actually inspected (`searched`, `notSearched`, `rationale`, `completeness`), and `NegativeFinding` carries a claim with the scopes checked and a confidence grade; a zero-hit result without coverage reads as "not found here", never as "does not exist". `ProviderHealthState`, `ProviderGeneration` (index/evidence two-clock generation), and `ProviderExplain` (stable-token truncation reasons, degraded read errors) are the knowledge-provider observability surface that adapters such as a CodeCortex bridge will report. All types are documented in [`src/types.ts`](src/types.ts) and projected in [docs/subsystems/context-engine.md](../../../docs/subsystems/context-engine.md).

## Model Experience

None, as this trusted seam registers no model-facing prompt, schema, tool, or message of its own; contributors own their message sources, and the engine only sequences and records what they contribute.

#### KV Cache effect

Indirect and contributor-owned; contributed messages append after the claimed user messages, following the reusable request prefix, so injection does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Sequencing only** — `prepareStep` orders and concatenates contributions; retrieval planning, budget partitioning, hydration verification, and packing policy land in later phases and enrich this seam rather than replace it.
- **No provider adapters yet** — the session-query, memory, CodeCortex, and LSP adapters that will produce `Evidence` at scale are deferred; `file-reference-local` is the first contributor.
- **No per-contributor cancellation policy** — contributors receive the step signal and must pass it through; the engine does not yet enforce per-contributor timeouts.
