# @relay-harness/rlh-session-history-context

English | [中文](README.zh.md)

Host-owned Context Engine contributor for durable conversation history. It runs only for `purpose: 'prompt_enhancement'`; ordinary `agent_step` requests receive no contribution, so AgentLoop never gets a duplicate copy of its existing transcript.

The contributor resolves `StepContextInput.caller.sessionId` through `ctx.sessions`, inspects the complete immutable event log and current Session surface, and emits one untrusted JSON-framed recall message. It admits only current-surface direct-user/model exchanges whose durable `turn/end` is `completed`, plus compaction checkpoint replacements whose matching `compaction/start` → `compaction/summary` → replacement → successful `compaction/end` lifecycle is complete. Recall/injected context, tools, failed/interrupted/incomplete turns, shadowed events, and unapproved checkpoints never re-enter the result.

Selection keeps logical surface chronology while preferring the newest units under `maxExchanges`, `maxChars`, and the shared `ctx.tokenMeter` estimator's `maxTokens`. An oversized newest unit is clipped without breaking the JSON envelope. Every admitted source event produces revision-bound, SHA-256-digested Evidence with current freshness, verified status, role/turn/checkpoint provenance, and explicit selection reasons; Coverage records the full log/surface scope, policy exclusions, budget omissions, and clipping.

The base bundle composes this provider once. The Web Prompt Enhancement adapter reaches it through the same `ctx.contextEngine.prepareStep()` pass as `@file`, code, and memory providers; this package never calls the Prompt Enhancement service and owns no second composer.

## Model Experience

### Durable Session history recall

#### What the model sees

One plugin/user-role message (`source.plugin = 'session-history-context'`, `form = 'recall'`) containing an untrusted JSON array of successful exchanges and approved checkpoints in chronological order. The current unsent draft remains a separate Prompt Enhancement message.

#### Token effect

The message is bounded simultaneously by exchange count, Unicode code points, and the shared deterministic token estimator. It is absent for empty history and all ordinary Agent steps.

#### KV Cache effect

Completed Session history changes the independent Prompt Enhancement request. It does not alter the ordinary Agent request prefix.

## Known Limitations and Deferred Work

- Selection is deterministic recency packing, not semantic history retrieval. A later shared planner may rank exchanges while preserving this provider's durable admission rules.
- The contributor includes text blocks only. Images, reasoning, tool calls, and tool results require separate purpose-specific evidence providers rather than lossy inline conversion here.
