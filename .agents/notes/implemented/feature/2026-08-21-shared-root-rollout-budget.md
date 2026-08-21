# Agent Note: Shared root-session rollout budget

Status: implemented

English | [中文](2026-08-21-shared-root-rollout-budget.zh.md)

## Problem

Per-request output limits and max-token continuation caps do not bound a long agent rollout. A root Agent can make many requests, spawn local descendants, and let each descendant spend independently. Provider dashboards eventually report aggregate usage, but they cannot steer an Agent before it consumes the remainder or stop a tool effect requested by the response that crossed a deployment budget.

The accounting must not charge a fork's copied history again, must remain isolated between unrelated roots, and must give every participating Agent truthful current guidance. Enforcement in one delegation tool or one provider would be bypassed by other consumers and transports.

## Decision

`@deepseek-ai/dsh-rollout-budget-controller` is an opt-in guard plugin with a required `limitTokens` and required `reminderAtRemainingTokens`. No package or base-bundle default invents a deployment spend ceiling. Optional `samplingTokenWeight` and `prefillTokenWeight` default to one and must be finite and non-negative.

The plugin resolves each local Session to its highest currently live durable ancestor and owns one process-local ledger per root id. It consumes each Session event sequence once and ignores the fork prefix below `SessionHeader.seedLength`. An `assistant/message` with usage contributes `max(0, outputTokens) × samplingTokenWeight + max(0, inputTokens) × prefillTokenWeight`; DSH's input bucket is already uncached, so cache-read and cache-write buckets are excluded.

Each Agent derives delivered reminder levels from durable plugin-sourced user messages in its own log. At pre-step, after delegating to later admission listeners, the controller appends at most one reminder for the greatest newly crossed threshold. A restored Agent therefore does not repeat a recorded level, while a new descendant receives the root's current remainder on its first request after a threshold.

When usage reaches the limit, the response and its accounting event remain committed. A global monotonic tool guard denies tool bodies requested by that response. Every later Agent pre-step throws `RolloutBudgetError` with live code `ROLLOUT_BUDGET_EXCEEDED` before another model request. A direct tool execution without an Agent has no root identity and stays outside this policy.

The per-root concurrency admission mechanism is separate and is owned by the [root-tree subagent admission decision](../architecture/2026-08-21-root-tree-subagent-admission.md). Capacity bounds simultaneous child lifetimes; rollout budget bounds aggregate model usage. Deployments may enable either or both.

## Alternatives considered

**Extend the max-token continuation controller.** Rejected because a cutoff continuation cap owns one turn's output completion, not input usage, successful responses, sibling Agents, or tools requested after aggregate exhaustion.

**Put the ledger in `SubagentRuntime`.** Rejected because the root Agent also spends budget and ordinary Agents exist without the subagent capability. Token accounting belongs beside Agent/session events; subagent lineage only supplies the parent chain.

**Enforce only at subagent start.** Rejected because an admitted child can make many requests, and the root can exhaust the budget without spawning anything.

**Throw from `session/event` when a response crosses the limit.** Rejected because that feed is post-commit, fire-and-forget, and contains observer failures. It is an observation point, not a veto. The next actual effect boundaries are tool dispatch and pre-step.

**Cancel every live Agent immediately.** Rejected because cancellation would discard or abort unrelated in-flight output and needs a new durable cancellation cause. Concurrent responses may finish and be retained; their tool effects are denied and their next requests cannot begin.

**Persist a process-global ledger in the first version.** Rejected because correct cross-process enforcement requires one transactional store, identity lifetime, and lease protocol. A partial file write or per-session copy would create split-brain budgets. The opt-in first version states its process-local reset explicitly.

**Count cache reads as full prefill.** Rejected because the imported prior-art formula weights non-cached input, and DSH already normalizes `inputTokens` to that bucket. Charging cache fields again would double-count.

## Consequences

One configured root tree receives shared weighted-token accounting, per-Agent durable reminders, tool denial on the crossing response, and fail-closed later sampling. Unrelated roots remain independent. Forked history and rescans do not inflate the total.

Already in-flight requests can overshoot the ceiling, and remote subagent backends without local usage events are invisible. Plugin restart also loses cold-descendant totals until those Sessions load. These limits are explicit rather than masked by an approximate durable format.

The live error event preserves `ROLLOUT_BUDGET_EXCEEDED`; the current generic loop records non-provider extension throws in durable `turn/end` facts under `UNKNOWN`. Consumers needing the specific code use the live event until generic extension-failure normalization gains its own typed path.

Real Agent-loop and Loader-YAML coverage pins root/child sharing, threshold delivery, exhaustion, fork-prefix exclusion, rescan idempotence, missing ancestors, downstream rejection, durable reminder recovery, weighted cache exclusion, tool allow/deny, Agent-less tools, fail-loud configuration, and invariant registration. The package source reaches per-file 100% statements, branches, functions, and lines.
