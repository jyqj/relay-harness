# @relay-harness/rlh-prompt-enhancement-context-engine

English | [中文](README.zh.md)

Context provider that maps Prompt Enhancement onto the target Agent's existing `ctx.contextEngine`. It calls `prepareStep()` once with `purpose: 'prompt_enhancement'`, the exact draft as the claimed user message, detached caller identity (`sessionId`, `agentId`, workspace, preset, and origin), and caller cancellation. Returned messages stay in Context Engine order; its existing contribution, Evidence, and coverage types are projected into an opaque JSON trace rather than redefined here. The adapter snapshots the complete trace through the Session lossless-JSON boundary before returning it, so even a structurally supplied replacement engine cannot leak `Map`, `Date`, cycles, or other non-wire values into the Remote result.

The adapter fails loud when the Agent scope has no Context Engine. An empty prepared result is valid and distinct from a missing engine.

## Model Experience

### Shared prepared context

#### What the model sees

Under `purpose: 'prompt_enhancement'`, the Prompt Enhancement model sees only messages selected by the shared Context Engine contributors, followed by the enhancement provider's draft message. The base composition's purpose-specific Session History contributor adds completed direct-user/model exchanges and approved compaction checkpoints while declining ordinary Agent steps.

#### Token effect

Contributor messages add data-dependent tokens to the independent auxiliary request. The adapter adds no additional prose.

#### KV Cache effect

Context changes may change the auxiliary request, but never the main Agent request's prefix.

## Known Limitations and Deferred Work

- The Context Engine remains sequencing-only; planner budgets, timeouts, and purpose-aware contributor policies depend on that shared service's evolution.
- Session History uses deterministic recency packing rather than semantic ranking; cross-session semantic history remains a separate provider concern. The adapter deliberately does not compose history itself.
