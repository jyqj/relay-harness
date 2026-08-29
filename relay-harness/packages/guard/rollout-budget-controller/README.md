# @relay-harness/rlh-rollout-budget-controller

English | [中文](README.zh.md)

An opt-in shared rollout budget for one root Agent and every local descendant. It is not a tool. The plugin accounts each own-suffix `assistant/message.usage` once, charges output and uncached input with configurable weights, inserts threshold reminders into each Agent's next model request, rejects later pre-steps after exhaustion, and denies tool effects requested by the response that crosses the limit.

This controller is separate from [`rlh-token-budget-controller`](../token-budget-controller/README.md): that plugin continues one response after a per-request `max-tokens` cutoff; this package limits aggregate model spend across many requests and subagents.

## Config

No limit is invented by the package or base bundle. A deployment that loads it must choose the budget and reminder thresholds:

```yaml
- id: rollout-budget-controller
  name: '@relay-harness/rlh-rollout-budget-controller'
  config:
    limitTokens: 200000
    reminderAtRemainingTokens: [50000, 20000, 5000]
    samplingTokenWeight: 1 # default
    prefillTokenWeight: 1  # default
```

`limitTokens` is a positive safe integer. Every reminder threshold is a positive safe integer strictly below the limit. Weights must be finite and non-negative. Loader validation and the direct `apply()` boundary both fail loud on invalid values.

## Accounting and enforcement

The highest currently live durable ancestor is the accounting root. The root session and every local child/grandchild resolve to one process-local ledger; unrelated roots remain isolated. Fork seeds are not charged again: events below `SessionHeader.seedLength` belong to the ancestor's already-counted prefix, and each session's own suffix is consumed once by event sequence. Rescanning a live or resumed Session therefore does not duplicate usage.

Weighted usage is `outputTokens × samplingTokenWeight + inputTokens × prefillTokenWeight`. RLH defines `inputTokens` as uncached input, so `cacheReadTokens` and `cacheWriteTokens` are deliberately not charged. Provider-reported negative buckets clamp to zero.

Exhaustion is fail-closed at the next effect boundary. The response that crosses the limit is retained. Any tool calls in that response reach the global monotonic tool guard and settle as denied without invoking their bodies; any later Agent pre-step throws `RolloutBudgetError` (`ROLLOUT_BUDGET_EXCEEDED`) before another model request. Direct tool executions without an Agent have no root identity and remain outside the policy.

Thresholds are evaluated from the shared remaining weighted tokens. Every Agent receives each crossed level once, on its next entered pre-step. The reminder is a durable plugin-sourced user message; a restored Agent scans its log and does not repeat an already-recorded level. Crossing several levels between two requests produces one reminder with the current remainder.

The design rationale and rejected enforcement locations are recorded in the [shared rollout-budget Agent Note](../../../.agents/notes/implemented/feature/2026-08-21-shared-root-rollout-budget.md).

## Model Experience

### Remaining-budget reminder

#### What the model sees

At most one new reminder in a request, once per crossed configured threshold for that Agent.

##### Reminder

```markdown
You have <remaining> weighted tokens left in the shared root-session rollout budget.
```

#### Token effect

One short user message per crossed level per active Agent. Accounting includes the model call that reads it; no reminder is emitted before the first threshold or after exhaustion.

#### KV Cache effect

Append-only in each Agent Session. The reminder follows the reusable request prefix and does not invalidate earlier KV-cache entries.

## Known Limitations and Deferred Work

- **Process-local aggregate** — plugin restart resets the cross-session ledger. Loaded Sessions are rescanned without duplication, but usage belonging only to cold descendant Sessions is unavailable until those Sessions are loaded. A durable cross-process budget needs one persistence transaction and lease owner.
- **Local-session usage only** — out-of-process subagent providers that do not append their model usage to a local child Session are not charged. Extending `SubagentResult` with provider-neutral verified usage requires every remote protocol to supply equivalent facts.
- **Concurrent overshoot** — model calls already in flight can all finish and report usage after another call crosses the ceiling. Their later tools are denied, but the accounting total may exceed the configured limit.
- **Adapter-reported usage** — incorrect or missing `assistant/message.usage` cannot be reconstructed exactly. Missing usage contributes zero; negative input/output buckets clamp to zero.
- **Live error versus durable normalization** — the live `agent/error` carries `RolloutBudgetError` and its stable code. The generic Agent loop currently records non-provider extension throws on `turn/end` under `UNKNOWN`; hosts that need the specific code consume the live error event.
