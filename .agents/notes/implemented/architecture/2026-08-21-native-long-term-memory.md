# Agent Note: Native governed long-term memory

Status: implemented

English | [中文](2026-08-21-native-long-term-memory.zh.md)

## Problem

The Harness persisted exact model history, compaction replacements, and searchable Session events, but it had no first-party long-term-memory decision record. Third-party MCP tools could store data, yet the Agent loop did not define when to recall it, how model-visible recall remained reconstructable, how a failed turn settled provider work, or which Session events justified an active memory.

Treating Session search as memory would make raw history a current fact store. Copying raw turns into another database would create two competing transcript sources. Automatically trusting model summaries would let one inference or untrusted tool result become a persistent cross-session input.

## Decision

Long-term memory is a capability seam under `packages/memory`: `@deepseek-ai/dsh-memory` defines `ctx.longTermMemory` and `ctx.memoryExtractionQueue`; `memory-sqlite` provides canonical revisions, retrieval, and extraction jobs; `memory-agent` consumes recall during Agent turns; `memory-extractor-llm` captures and extracts completed turns; `tool-memory` exposes governed model operations. The standard preset mounts recall and tools, while the base bundle owns one canonical provider at `$DSH_HOME/memory/memory.db` and explicitly enables extraction only for standard sessions.

SessionEvent remains the conversation evidence source. Each memory revision cites a Session id and earlier event seqs; the canonical memory journal records the decision made from that evidence. Current rows and FTS are materialized views. A tombstone removes recall eligibility without deleting its prior revisions or evidence.

Every operation addresses workspace, user, and stable Agent Scope. Session ids identify evidence and prepared turns, not long-term visibility. The standard preset uses the session cwd, local OS user, and `deepseek-harness` Agent id, so matching sessions share memory while different workspaces or users do not.

Kinds are preference, fact, constraint, decision, procedure, and lesson. Live task state stays outside memory. Status is candidate, active, disputed, superseded, or tombstoned. Active state requires user-stated or successful-tool-result evidence; agent proposals and external observations cannot become active at the provider operation. Provider-side secret scanning applies to every Consumer.

The Agent Consumer prepares recall only for direct user text on the first step. It packs active candidates into a character-bounded, separately sourced `user/message` whose fixed warning marks the JSON as untrusted, potentially stale evidence. The Agent loop logs that message before deriving the request, preserving model-visible/logged equivalence. Session Query excludes every recall-form message from semantic documents, preventing derived recall from recursively becoming episodic evidence.

Prepared turns settle at final `turn/end`. Completed and max-token turns commit the exact memory ids admitted to the model; every other outcome aborts. Provider failures fail open for the Host turn. Disposal drains active provider calls and aborts remaining prepared handles.

Model writes do not rely on prompt discipline alone. `memory_remember` and content-changing `memory_update` activate only when an exact excerpt is found in a direct user message or successful tool result. Otherwise they create a candidate. `memory_forget` requires an exact direct-user deletion excerpt. The provider repeats status, trust, evidence, Scope, and secret enforcement.

Automatic extraction also stays outside the Agent loop. Completed and max-token turns project only direct user messages and successful tool results; derived recall/plugin messages, reasoning, failures, memory/session/skill outputs, subagents by default, and secret-bearing sources are excluded. The bounded snapshot enters an idempotent SQLite job keyed by Scope, session, turn, and source hash. Persisted attempts, expiring leases, retry scheduling, final-lease settlement, and terminal result hashes make interruption and restart explicit.

The auxiliary LLM returns proposals, never authoritative writes. Strict JSON parsing and exact quote grounding admit user-stated or action-verified active memory; active content is the durable quote rather than the model paraphrase. External and ungrounded proposals remain candidates. Exact normalized kind/content deduplication makes a partially completed job safe to retry and promotes an existing matching candidate instead of forking identity.

## Alternatives considered

**Ship one third-party memory MCP as the default.** Rejected: MCP supplies tools and transport, not the Host turn lifecycle, durable recall provenance, or provider-independent governance.

**Adopt ALTM's complete L0-L4, graph, persona, and autonomous-governance stack.** Rejected for the default: its prepare/commit/abort, Scope, evidence, lifecycle signals, and rank-fusion ideas are useful, but a mandatory Python service, graph, and persona pipeline would add independent truth and deployment complexity before the first-party seam existed.

**Adopt dsh-meow's seven tables and first-message prefix.** Rejected as the core contract: its practical Hooks and transcript disclosure informed the Consumer, but fixed tables, sidecar seen state, full first-turn injection, and direct model mutation do not provide append-only evidence governance.

**Store memory recall only in request-local state.** Rejected: a replay could not reconstruct what the model saw, violating the Session log invariant.

## Verification

Provider tests exercise append-only revisions, Unicode/trigram retrieval, Scope isolation, active/candidate eligibility, exact dedup and promotion, prepare/commit/abort idempotence, tombstones, schema migration, extraction-job leases/retries/terminal states, persistence reopen, evidence validation, and secret rejection. Tool tests drive the real Tool Runtime and provider for verified activation, candidate fallback, search/read, deletion authority, and HMR disposal. Agent tests cover fail-open preparation, subagent policy, final settlement, and unload aborts. Extractor tests cover source exclusion, forged quotes, external observations, exact successful-tool activation, malformed output retry, interruption, final lease expiry, provider failure, and restart recovery.

An actual Agent loop test proves the same recall message enters the adapter request and Session log and that final turn settlement updates access accounting. A restart test extracts from one completed Agent session and recalls from a fresh session. The shipped Web composition test boots the real base bundle and standard/minimal presets, pins the canonical database to a temporary path, verifies standard automatic extraction and cross-session recall, and keeps minimal memory-free.

## Consequences

The Harness has one replaceable long-term-memory seam without changing the Agent loop. Local use has no external service or embedding requirement. Recalled data is explicitly lower-trust than current user intent and verified tool output, and every active write has inspectable durable evidence.

Lexical FTS, explicit model tools, and durable evidence-grounded automatic extraction are the current implementation. Exact tokenizer budgeting, semantic embedding providers, user review UI, import/export, and cited-use feedback remain separate Consumers or providers that can extend this seam without changing Session history or existing memory revisions.
