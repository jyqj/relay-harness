# Agent Note: Parallel tool-call execution by per-call safety

Status: implemented

English | [中文](2026-07-10-parallel-tool-call-execution.zh.md)

## Problem

An assistant message may contain several sibling `tool-call` blocks. Running them serially adds the latency of independent reads and web requests even though the model has already requested them together.

Concurrency is a host scheduling concern, not model-facing tool metadata. The loop needs to decide which calls may overlap without hardcoding tool names or exposing scheduler policy in the JSON schema.

The session log remains authoritative: every started call has an audit event, ordinary completion and cancellation pair calls with results, and model history observes committed results in the original call order regardless of completion order.

## Decision

Each tool may provide an optional `isConcurrencySafe(args)` classifier. It is synchronous and pure: it examines only the current call's parsed arguments and performs no I/O or mutation. Only an explicit `true` opts in; a missing classifier, invalid arguments, a thrown classifier, or any other return value makes the call exclusive. The canonical type contract lives in the [tool data structures](../../../../docs/subsystems/tools.md).

The classifier is deliberately unary. Returning `true` is the tool's promise that this call may overlap with any sibling call that also returns `true`; the scheduler does not compare calls or prove that their resource accesses are compatible.

The unary classifier remains input-sensitive. A tool may classify a read-only operation as parallel and a mutating operation as exclusive. Relational safety uses the separate `resourceIntents` contract: calls enter the parallel pool, then fair read/write locks serialize equal canonical keys while unrelated keys overlap ([decision](../architecture/2026-08-21-tool-resource-intent-locks.md)). Calls that declare neither mechanism remain exclusive.

`defineTool()` validates arguments before invoking a typed classifier. Invalid arguments classify as exclusive and produce the ordinary argument error only if the call executes. `ctx.tools.executionMode(exec)` resolves the live tool definition for a direct inspection call; the agent loop classifies through the request-scoped snapshot that supplied the model's schemas. Unknown tools fail closed to exclusive. The [request tool snapshot](../architecture/2026-08-21-request-tool-snapshot.md) owns capture and HMR identity.

A tagged mode, rather than a public boolean scheduler API, keeps resource-aware variants representable without changing the classifier contract.

## Scheduling and ordering

The loop waits for the complete assistant message, parses every call once, creates a distinct `ToolExecution` for each call, and scans them in model order. Consecutive parallel calls form one group; every exclusive call forms a singleton group and an ordering barrier. Groups execute sequentially. Classification is evaluated before each start through the same request snapshot that advertised the definition. A registry mutation cannot substitute or reclassify a pending call in that response; it affects the next prompt assembly.

For example:

```text
[parallel read(A), parallel read(B), exclusive write(A), parallel read(C)]

→ [read(A), read(B)]
→ [write(A)]
→ [read(C)]
```

`read(A)` and `read(B)` may overlap. `write(A)` starts after both finish, and `read(C)` starts after the write finishes.

Every group uses a rolling pool bounded by `maxParallelToolCalls`: the loop starts calls in model order up to the cap and starts another whenever one settles. An exclusive group is a pool of one. A cap of `1` preserves serial execution.

Only dispatch and the tool body overlap. `tools/pre-execute` and `tools/post-execute` run in model order because middleware may maintain ordering-sensitive state. `tools/execute` wrappers run around concurrent dispatches and therefore must be reentrant across distinct executions.

Each started call appends `tool/call` immediately before its pre-execute gate. Completed dispatches occupy model-order slots, and a commit cursor appends `tool/result` and collects `additionalContexts` only when the next slot is ready. Live surfaces may show several pending calls, but results and post-tool context remain model-ordered.

An abort before a group starts records no calls from that group. An abort during a group stops replenishment, waits for already-started calls, commits their results in order, drains accepted batch context after those results, and then ends the step through the existing abort path. Calls that never start have no audit event. An unexpected scheduler failure stops new dispatches, waits for every already-started dispatch to settle, and rethrows the first failure. Because that failure is terminal internal state rather than a tool outcome, the loop does not invent tool results for rejected or uncommitted calls.

Code Mode presents one native `run_code` call, then schedules its nested binding calls through a snapshot-bound staged scheduler with the same ordered pre/post lanes, exclusive barriers, and bounded parallel dispatch as native calls. Native sibling calls in `mode: 'both'` use the loop scheduler.

## Safety contract

A tool that returns `true` promises that its body is safe to run at the same time as other parallel calls. It must not directly mutate the parent session or other parent-owned state; it returns its outputs to the loop, which commits them in model order.

Any shared state touched during execution must be concurrency-safe. This includes tool wrappers and providers: they may serialize internally or enforce their own capacity, but they must support concurrent dispatch without corrupting state.

## Configuration and declarations

`maxParallelToolCalls` is a positive AgentLoop deployment cap shared by every agent the factory creates. It defaults to `10`; `1` preserves serial execution. Exact fields and defaults live in the generated [configuration catalog](../../../../docs/config-catalog.md).

The shipped declarations are conservative. Web search, web fetch, filesystem read, the session-query trace/read tools, and subagent delegation opt in — delegation because a child works in its own session and its run never mutates the parent session, with sibling workspace coordination owned by the model ([parallel subagent Agent Note](2026-08-09-parallel-subagent-delegations.md)). Filesystem read/write/edit and the string-replace editor use canonical provider-key resource locks, so unrelated targets overlap and conflicts serialize. Bash tools, the session-query search tools, workflow, user interaction, todo mutation, and Cordis mutation tools remain exclusive. Code Mode itself is one outer call, while its nested scheduler applies the captured classifiers and resource locks. Bash has no proven input-sensitive classifier and remains exclusive.

Filesystem read relies on a narrow recorder exception: its synchronous observation updates may settle out of order, but write and edit re-check the observed version before mutation, so stale state only produces `FS_STALE_VERSION`.

## Verification

Unit coverage pins fail-closed classification, typed argument validation, grouping, barriers, request-snapshot stability across registry replacement, the rolling cap, distinct execution objects, middleware order, ordered results and context, abort draining, and scheduler-failure quiescence. First-party tests pin each parallel declaration.

Snapshot coverage pins the visible multi-call transcript: pending calls may overlap while completed results remain model-ordered. Code Mode coverage pins its captured nested scheduler and ordered result boundary. No provider-backed e2e is required because scheduling is deterministic loop behavior.

## Alternatives considered

**Keep serial execution.** This avoids new ordering and abort cases but retains unnecessary latency for independent sibling calls.

**Use one tool-level boolean.** A fixed `supportsParallelToolCalls` flag is smaller but cannot distinguish a tool's read-only and mutating operations. The argument-sensitive classifier preserves that distinction.

**Use stateful classification.** Giving the classifier a live agent, registry, or I/O access makes the decision depend on when it runs and creates a gap between classification and dispatch. Mutable authorization and stale-state checks remain execution-time responsibilities.

**Infer sibling conflicts in the scheduler.** Rejected because argument names and path spellings do not establish shared resource identity. Explicit tool-owned `resourceIntents` were adopted instead; the provider resolves canonical keys and the runtime owns common conflict semantics.

**Parallelize the complete tool pipeline.** This keeps the loop on the public one-call API but runs pre- and post-execute middleware concurrently. Existing guards and hook bridges may carry ordered state, so only dispatch overlaps.

**Expose staged methods or a scheduling waterfall.** Public `prepare` / `dispatch` / `finalize` methods or a `tools/execution-mode` event add extension surface before another consumer needs it. The loop uses an internal scheduler view, while `executionMode(exec)` leaves an insertion point for a policy hook.

**Convert scheduler failures into tool results.** AgentLoop cannot determine whether a rejected dispatch invoked the tool body; ToolRuntime owns body-invocation state and typed tool outcomes. Internal scheduler failures therefore remain terminal instead of being reclassified as `ABORTED` results.

**Start calls while the model streams.** This may reduce latency further but changes assistant-message authority, replay, and call/result pairing. The scheduler starts only after the assistant message is complete.

**Use fixed-size windows.** Waiting for every call in one window before starting the next leaves capacity idle behind a slow call. The rolling pool preserves the cap without that delay.

**Expose concurrency metadata to the model.** The model can already emit sibling calls. Host scheduling metadata would enlarge requests without improving tool choice.

## Consequences

The unary path remains fail-closed and simple. Tools with provider-backed canonical identity can opt into resource locks; tools that declare neither stay exclusive. A tool that returns `true` too broadly or declares incorrect resource keys can still expose latent shared-state races.

Parallel calls may begin in cases where serial execution would have aborted before reaching them. The scheduler therefore records only started calls, drains them on abort, and never starts replacements after cancellation.

Ordered commits may hold a fast result behind a slow earlier sibling. This preserves replay and model-history order while live surfaces still show pending progress.

Concurrent external calls can compete for quota or process capacity. Providers own their capacity controls; the loop cap only limits calls from one agent step.

Tool registration is a sampling boundary. Registry mutations affect the next request snapshot; every call in an already sampled response retains the definition and classification the model was shown.

A terminal scheduler failure may leave recorded calls without results before the failed step closes. Waiting for live dispatches preserves quiescence without misreporting those internal failures as tool outcomes.
