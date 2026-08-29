# Agent Note: Memory as a shared Context Provider

Status: implemented

English | [中文](2026-08-29-memory-context-provider.zh.md)

## Problem

Proactive memory recall bypassed Context Engine through `agent/pre-step`. Its model-visible message was durable, but no Context Evidence or coverage survived, Prompt Enhancement could not reuse the same retrieval policy, and settlement assumed every rendered id entered the request even when a later pre-step listener removed or rewrote the proposal. The Context Engine was Web-only, so headless standard sessions could not depend on it.

## Decision

Context Engine is a host-plane base service for every profile. `StepContextInput` now carries a detached `StepContextCaller`: durable session and Agent ids, workspace partition, optional owning turn/step, effective preset (including a logged blank-session switch), and origin. AgentLoop and the Prompt Enhancement adapter construct it from the authoritative Session state.

`memory-agent` is one host-owned Context contributor with a shipped `standard` preset gate. On an Agent turn's first step it preserves provider `prepare -> commit/abort` semantics, packs only active and non-expired candidates, and emits revision-bound Memory Evidence, trust/provenance domain data, and bounded coverage. At `turn/end`, injected ids are committed only when `context/prepared` links the exact proposed recall message to an admitted `user/message`; removed or rewritten proposals commit an empty injected set. Errors, cancellation, missing Assistant output, replacement, and unload abort the prepared handle; a failure after provider prepare but before pending-map ownership also aborts that otherwise-unowned handle. Evidence digest covers the complete injected item payload, not only content/summary.

For `prompt_enhancement`, the same contributor searches the same exact Scope and returns the same message/Evidence/coverage shape without calling prepare/commit/abort. `SearchMemoryInput.recordAccess: false` makes this auxiliary preview read-only: it changes no access counters, signals, turn rows, or Session events.

## Alternatives considered

- **Keep independent pre-step injection** — rejected because it preserves two context pipelines and cannot power the shared trace or Prompt Enhancement.
- **Call `prepare()` for Prompt Enhancement** — rejected because an unsent draft has no host turn to settle and must not affect usage ranking.
- **Trust the rendered id list at settlement** — rejected because downstream admission may remove or rewrite a proposal; the durable trace is the exact authority.
- **Keep Context Engine in the Web bundle** — rejected because CLI/headless Agent sessions then silently lose memory and every other contributor.

## Consequences

Agent recall, Prompt Enhancement recall, durable provenance, and user-visible context inspection now share one path. The provider still fails open and preserves the existing character and candidate budgets. Custom deployments can allow all presets or configure an explicit durable preset list. The later [Governed Memory Center Note](../feature/2026-08-29-governed-memory-center.md) closes candidate review, edit/tombstone, explicit conflict comparison, visible freshness, and attached-session “why used”; cross-session aggregation and outcome/relevance feedback remain open.
