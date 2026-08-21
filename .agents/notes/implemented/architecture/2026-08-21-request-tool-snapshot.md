# Agent Note: Request-scoped tool snapshots

Status: implemented

English | [中文](2026-08-21-request-tool-snapshot.zh.md)

## Problem

Prompt assembly and tool execution read the scoped tool registry at different times. A Cordis registration could unload or be replaced while the model streamed, so one request advertised one schema and later executed another definition, changed its concurrency classification, or returned `UNKNOWN_TOOL`. Code Mode had the same split across its generated SDK, selected code backend, binding catalog, and nested dispatch scheduler.

The final `system-prompt/assemble` result is authoritative. A listener may remove a schema deliberately, so freezing only the registry before that waterfall would still let execution bypass the final model-visible request.

## Decision

The default agent loop captures one `ToolRequestSnapshot` before each prompt assembly. The snapshot owns strong references to the resolved scoped definitions, presentation mode, detached wire schemas, Code Mode SDK schemas and text, and the selected code runtime. It contributes those schemas through the symbol-keyed assembly context, then binds model-direct execution to the tool names in the post-waterfall `PromptAssembly`. A listener-added name with no captured definition remains unexecutable; a removed name is refused even though its definition was present at capture.

The snapshot exposes a staged scheduler whose prepare path records the selected definition on each `ToolRunContext`. Dispatch, output validation, rendering, post-policy value replacement, and wrapper-authored success normalization use that recorded definition rather than resolving the live registry again. Direct `ctx.tools.execute()` calls apply the same per-execution definition capture at admission. Live pre/around/post policy, approval, guards, and cancellation remain live: security policy changes apply immediately without substituting the implementation the request advertised.

Code Mode inherits the outer execution's snapshot. Its generated SDK, backend, binding names, classifiers, and nested scheduler therefore use the same captured view; a registry or backend replacement affects the next sampling request only. The snapshot keeps definition and backend objects alive until the step settles and releases them on every reject, empty-step, failure, cancellation, ordinary completion, and tool-settlement path. Registration disposal removes a tool from future captures immediately; it cannot rewrite an already accepted request.

This mechanism is internal to `dsh-tools` and `dsh-agent-loop`: `TOOL_RUNTIME_REQUESTS`, `TOOL_REQUEST_SNAPSHOT`, and the snapshot-bound scheduler are symbol-keyed integration points rather than plugin extension surfaces. The public registry API still presents the current live catalog to ordinary inspection callers.

## Alternatives considered

**Continue re-resolving before each start.** Rejected because live reclassification lets a request execute a definition and output contract the model never received. HMR responsiveness is not worth breaking request identity.

**Freeze hooks, approval, guards, and all policy with the definitions.** Rejected because security policy must be able to deny an in-flight request after capture. The snapshot freezes capability identity, not authorization decisions.

**Block complete Cordis fiber teardown until every captured request finishes.** Rejected because unrelated effect disposal can be the operation a tool awaits, creating a teardown deadlock. Strong references retain the definition and backend identity; a provider that independently closes an external resource may make the captured tool fail, but it cannot redirect the call to a replacement implementation.

**Trust the pre-waterfall schema set.** Rejected because `system-prompt/assemble` is authoritative and may intentionally remove tools. The snapshot binds direct execution after that waterfall.

## Consequences

One sampling request now has one tool capability identity across prompt generation, provider streaming, native scheduling, Code Mode, result normalization, and finalization. HMR changes are visible on the next step rather than midway through the current one. This removes live registry reclassification from the scheduler contract and trades immediate replacement for deterministic request behavior.

The snapshot retains definition and backend objects for the duration of one step. It does not preserve arbitrary external resources that a provider closes independently; such teardown becomes a failure of the captured implementation, never silent execution by a newer one. Final assembly listeners that rewrite a schema without changing its name remain responsible for keeping that schema compatible with the captured definition's validator and output contract.

