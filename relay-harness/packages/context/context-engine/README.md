# @relay-harness/rlh-context-engine

English | [中文](README.zh.md)

Service Definition of the local context engine seam (`ctx.contextEngine`): a context-contributor registry and one deterministic, purpose-tagged `prepareStep` pass per request, plus the evidence, coverage, and provider-observability vocabulary that contributors and knowledge-provider adapters exchange. Design authority: Relay root repository `docs/adr/0006-local-context-engine.md` (ADR-0006) and `docs/agent/context-engine.md`.

AgentLoop calls the seam between inbox claim and prompt assembly (see [architecture turn flow](../../../docs/architecture.md#turn-flow)); contributed messages append to the step's user messages and are recorded as durable `user/message` events. On an accepted step, AgentLoop also records one log-only `context/prepared` trace after those messages and before the model request. The trace keeps contributor attribution, JSON-safe evidence, coverage, and exact message-event seq links; it does not duplicate transcript content. A step without contributions is byte-identical to a deployment without the service.

## Service API (`ctx.contextEngine`)

| Member | Semantics |
|---|---|
| `registerContributor(contributor)` | Atomically reserve a unique non-empty contributor id; an invalid or duplicate registration publishes nothing and throws `ContextEngineError` (`CONTEXT_ENGINE_INVALID_CONTRIBUTOR` / `CONTEXT_ENGINE_CONFLICT`). Returns a disposer removing exactly that registration. |
| `prepareStep(input)` | Run every registered contributor once, in registration order, with explicit purpose, messages, abort signal, working directory, and detached durable caller identity (session, Agent, workspace, turn/step, preset, origin); detach, lossless-JSON validate, and freeze every returned contribution; then return attributed contributions plus message, evidence, and coverage aggregates. A malformed payload or duplicate/empty evidence id fails atomically with `CONTEXT_ENGINE_INVALID_CONTRIBUTION`. Returns `undefined` when nothing was contributed. |

Contributors run sequentially by registration order so the packed message order is deterministic and reproducible across restarts; parallel fan-out arrives with the retrieval planner. The required `purpose` keeps ordinary agent-step retrieval and side-effect-free Prompt Enhancement preparation on one seam without inferring intent from message text. Working sets and explicit references arrive inside the messages themselves (file mentions, session references), keeping request construction deterministic without a model call.

## Vocabulary

`ResourceRef` addresses one resource as `sourceId` + opaque `key` + optional `revision` (omitted means explicitly unknown, never "any revision"). `Evidence` is one admitted observation bound to that revision, with `digest`, `truncated`, `freshness`, and `verification` — `unverified` is an explicit state, not a default, and provider-owned `domain` data must be lossless JSON because accepted evidence enters the durable trace. Evidence ids are unique across the complete preparation. `CoverageRecord` names what a retrieval actually inspected (`searched`, `notSearched`, `rationale`, `completeness`), and `NegativeFinding` carries a claim with the scopes checked and a confidence grade; a zero-hit result without coverage reads as "not found here", never as "does not exist". `ProviderHealthState`, `ProviderGeneration` (index/evidence two-clock generation), and `ProviderExplain` (stable-token truncation reasons, degraded read errors) are the knowledge-provider observability surface that adapters such as a CodeCortex bridge will report. All types are documented in [`src/types.ts`](src/types.ts) and projected in [docs/subsystems/context-engine.md](../../../docs/subsystems/context-engine.md).

## Model Experience

None, as this trusted seam registers no model-facing prompt, schema, tool, or message of its own; contributors own their message sources, and the engine only sequences and records what they contribute.

#### KV Cache effect

Indirect and contributor-owned; contributed messages append after the claimed user messages, following the reusable request prefix, so injection does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Sequencing only** — `prepareStep` orders and concatenates contributions; retrieval planning, budget partitioning, hydration verification, and packing policy land in later phases and enrich this seam rather than replace it.
- **Provider coverage is partial** — shipped file-reference, local-code-index, long-term-memory, prompt-specific Session History, and MCP Resource contributors now produce Evidence; general session-query, LSP, and unified planner policy remain deferred.
- **No per-contributor timeout policy** — contributors receive the step signal and must pass it through. The engine checks cancellation before and after every contributor and never runs a later contributor after abort, but it cannot interrupt a contributor that ignores the signal and does not yet enforce deadlines.
