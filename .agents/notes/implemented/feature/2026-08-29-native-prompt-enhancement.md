# Agent Note: Native Prompt Enhancement over the shared Context Engine

Status: implemented

English | [中文](2026-08-29-native-prompt-enhancement.zh.md)

## Problem

Relay documented Prompt Enhancement as a core user entry but shipped no runtime symbol, Host capability, Remote, or composer control. Implementing it as a private prompt composer would have duplicated file, memory, code, budget, Evidence, and trace decisions already assigned to the Context Engine. Routing enhancement through AgentLoop would expose tools and turn side effects to an operation whose only valid output is an editable unsent draft. A late result could also overwrite user edits unless the browser treated the original draft as a compare-and-set precondition.

## Decision

Prompt Enhancement is a complete capability path with distinct owners:

- `rlh-prompt-enhancement` owns one enhancement-provider registration, one Context Engine adapter registration, the generated `promptEnhancement.enhance` Remote, cancellation, and a result union that carries the exact original draft on every failure branch.
- `rlh-prompt-enhancement-context-engine` calls the target Agent's existing `ctx.contextEngine.prepareStep()` with the first-class `prompt_enhancement` purpose, exact draft, workspace, and cancellation. It forwards selected messages and projects existing contribution, Evidence, and coverage values into opaque JSON; it owns no retrieval logic or parallel Evidence types.
- `rlh-prompt-enhancement-llm` performs one independent `ctx.llm` call. It supplies no tools, runs outside AgentLoop, records the exact request before dispatch, bounds the complete input and raw output stream, and accepts strict JSON containing a proposed draft, assumptions, and open questions.
- `rlh-client-ui-prompt-enhancement` occupies `conversation.input.right` without changing InputBar. It stays visible in Simple and Developer modes, cancels on unmount, and shows an Original/Enhanced diff with assumptions and open questions. It safely reads the opaque trace and displays admitted File, Code, Memory, History, and MCP Evidence with its resource key, provider-owned selection reason, freshness, and verification state; unknown trace records remain hidden rather than acquiring a guessed source. Only explicit Accept may apply the proposal, only when the draft value and monotonic revision still equal the recorded attempt, and it writes through the ordinary input transaction so existing undo plus an explicit revision-guarded Undo restore that original. Busy-click cancellation crosses the Remote, and session switch/removal aborts stale work. It never submits.

The shipped Web composition uses the real Context Engine adapter. The base layer supplies a purpose-specific Session History contributor, so completed exchanges and approved compaction checkpoints join the same preparation pass without a Prompt-owned history composer. `rlh-prompt-enhancement-context-none` remains an explicit test or deployment adapter and cannot silently replace a missing engine. Missing context or enhancement providers fail loud while preserving the draft.

## Durable and model-request semantics

The auxiliary model request carries `purpose: 'prompt-enhancement'` as provider-neutral request metadata and omits `GenerateOptions.tools`. The purpose addition does not alter a provider wire by itself; adapters may adopt purpose-specific policy deliberately. `prompt-enhancement/llm-request` records the route, stable instruction, exact prepared messages plus framed draft, output cap, and optional Context Engine trace. The event is log-only and does not enter `deriveMessages()`. Accepting the proposal changes browser draft state only; ordinary conversation durability begins if the user later submits it.

## Consequences

The default Web path is Host service → shared Context Engine → no-tools LLM provider → generated Remote → composer control. A provider or cancellation failure cannot erase the original, and a result racing a newer edit cannot overwrite it. Context quality remains bounded by the shared engine and its composed contributors, so improving retrieval improves both Agent steps and enhancement without a second integration.

The proposal dialog renders the complete old and new drafts as removed and added blocks rather than computing a word-level inline diff. Its source explanation is a client projection of existing Context Engine trace fields and does not create a second provenance type or reinterpret provider evidence. The structured result carries both drafts, assumptions, open questions, and trace, so richer presentation does not require another Host protocol. The assembled browser test drives a completed history turn, the real generated Remote and auxiliary replay provider, proposal review, accept, input transaction, undo, cancellation, and the absence of any enhancement-triggered turn submission.

## Alternatives considered

- **Independent `EnhancerContextComposer`** — rejected because it would duplicate source selection, Evidence, budgets, permission, freshness, and trace policy and drift from Agent context.
- **AgentLoop turn with tools disabled by prompt wording** — rejected because prompt wording is not execution enforcement, a turn would still alter durable conversation lifecycle, and the LLM service already supports independent auxiliary requests.
- **Draft-only fallback when Context Engine is missing** — rejected for the shipped Web path because it would make miscomposition look successful. The separate context-none package keeps that behavior explicit where a deployment truly wants it.
- **Automatic submission or unconditional late replacement** — rejected because enhancement is an edit proposal. Submission remains a user action, and compare-before-replace preserves edits made while the request is running.
