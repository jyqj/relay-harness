# Agent Note: Context engine spine — step-context seam between claim and assembly

Status: implemented

English | [中文](2026-08-26-context-engine-spine.zh.md)

## Problem

Model-visible request context was a set of independent pre-step plugins (`session-reference`, `time-context`, `tmux-context`), each with its own retrieval, rendering, and injection logic, and no shared vocabulary for what the context rests on: which source, which revision, what was searched. The Relay root repository's context-engine design (`docs/adr/0006-local-context-engine.md`, ADR-0006, and `docs/agent/context-engine.md`) calls for a local control plane that turns retrieval results into revision-bound evidence before anything reaches a model request — and for AgentLoop to consult it between inbox claim and prompt assembly, where the claimed messages are visible but the prompt is not yet frozen.

## Decision

AgentLoop gained one optional seam in `preStep()`: after `this.inbox.claim(...)` and before the tool snapshot capture and `systemPrompt.assemble`, the loop reads `this.loopCtx.get('contextEngine')` and, when present, awaits `prepareStep({ messages: claimed, signal, cwd })`. Contributed messages append to the step's user messages ahead of the runtime-context snapshot, flow through the ordinary `agent/pre-step` waterfall, and are recorded as durable `user/message` events — so model-visible ⟺ logged holds without a new session event type. A step with no contributions, or a deployment without the service, is byte-identical to before.

The loop consumes the engine through a structural interface declared next to `VisionMessageRewriter` (`StepContextEngine`), taking no dependency on the plugin package — the same optional-service pattern as `visionFallback`.

The seam itself is `@relay-harness/rlh-context-engine` (`ctx.contextEngine`, Service Definition): a contributor registry (`registerContributor`, unique ids, disposers, all-or-nothing validation) and `prepareStep`, which runs contributors sequentially in registration order so packed message order is deterministic across restarts. Its `src/types.ts` owns the protocol vocabulary migrated from the audited reference designs: `ResourceRef`/`Evidence` (revision-bound observations, `unverified` as an explicit state), `CoverageRecord`/`NegativeFinding` (zero hits read as "not found here", never "does not exist"), and `ProviderHealthState`/`ProviderGeneration`/`ProviderExplain` (two-clock generation, stable-token truncation reasons) for the knowledge-provider adapters later phases will add.

## Alternatives considered

- **A `system-prompt/assemble` waterfall listener** — could see an `AssembleContext` field but runs on the assembly object, not the claimed messages, and cannot order contributed messages as claimed user messages without re-deriving them; it also happens after the tool snapshot.
- **An `agent/pre-step` plugin per source** (the status quo) — keeps per-plugin retrieval silos and provides no shared evidence protocol; the pre-step waterfall also runs after assembly, so context cannot influence prompt sections.
- **A new waterfall event between claim and assembly** — a larger `SessionEventMap`/SDK surface change for no additional capability over the optional-service read.

## Consequences

- `file-reference-local` becomes the first contributor: explicit `@path` mentions resolve against the session-header cwd through `ctx.fs`, with stat-identity revisions and content digests carried as `Evidence` records.
- Sequential contributor execution bounds per-step cost today; the retrieval planner, budget partitioning, and packing policy of later phases enrich `prepareStep` inside the seam rather than replacing it.
- The loop change updates [architecture turn flow](../../../../docs/architecture.md); `docs/subsystems/context-engine.md` projects the protocol vocabulary, and `scripts/gen-cordis-catalog.ts` maps `ctx.contextEngine` and its types to that page.
