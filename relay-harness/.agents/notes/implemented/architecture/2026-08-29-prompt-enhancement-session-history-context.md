# Agent Note: Prompt Enhancement Session history through Context Engine

Status: implemented

English | [中文](2026-08-29-prompt-enhancement-session-history-context.zh.md)

## Problem

The first native Prompt Enhancement slice reused Context Engine contributors for explicit files and other provider-owned evidence, but it supplied no durable conversation history. Pulling `session.deriveMessages()` inside the Prompt Enhancement adapter or LLM provider would have created a second context composer and recursively reintroduced prior recall/injected messages. It also would have treated failed turns and an incompletely committed compaction checkpoint as trusted history.

## Decision

`@relay-harness/rlh-session-history-context` is a host-owned, purpose-specific Context Engine contributor:

- it declines `agent_step`, because AgentLoop already owns its ordinary transcript;
- it resolves the caller exclusively from detached `StepContextInput.caller.sessionId` and the canonical `ctx.sessions` store;
- it folds the current durable Session surface, not a UI cache or search index;
- it admits direct-user/model exchanges only when their durable turn closes with `completed`;
- it admits a compact checkpoint only when the exact start, summary, replacement, and successful end lifecycle is ordered and complete;
- it excludes recall/injected messages, tools, failed/interrupted/incomplete turns, shadowed events, and failed checkpoints, preventing recursive context;
- it packs newest-first under exchange, character, and shared token-meter budgets, then emits selected units in logical chronological order;
- it attaches one content-digested, event-revision-bound Evidence record per admitted source event plus bounded Coverage explaining policy and budget omissions.

The base bundle composes the contributor once. Web Prompt Enhancement reaches it through the existing `prompt-enhancement-context-engine` adapter. No Prompt package imports or assembles Session history.

## Replay and lifecycle semantics

Evidence identity is the immutable Session event sequence under the caller Session, with a SHA-256 content revision. The provider's semantic log revision ignores only `session/end-seed`, the constructor-only resume marker, so replaying persisted events produces byte-identical history text, Evidence revisions, and Coverage before new semantic events arrive.

Compaction checkpoints retain logical surface position even though their replacement event has a later append sequence. Packing therefore follows `Session.surface.nodes`; it never sorts selected history by raw event sequence.

## Consequences

Prompt Enhancement now receives ordinary conversation continuity and approved summaries by default, while empty conversations add no tokens. The same Context Trace identifies every selected Session event and every policy/budget omission. A later retrieval planner may replace recency ranking, but it must preserve the durable success, compaction approval, recursion exclusion, and replay invariants implemented here.

## Alternatives considered

- **Read `session.deriveMessages()` in the Prompt LLM provider** — rejected because it bypasses Context Engine Evidence, Coverage, budgets, and purpose policy.
- **Index/search the current Session through session-query** — rejected for the initial local slice because the canonical live Session already owns an ordered current surface, while the default session-query database is intentionally unopened. Session-query remains suitable for cross-session semantic retrieval.
- **Include every user-role surface message** — rejected because recalls and injected policy would recursively become new evidence.
- **Include every compaction replacement** — rejected because a replacement without a successful close is not an approved checkpoint.
