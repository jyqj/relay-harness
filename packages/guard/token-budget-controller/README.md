# @relay-harness/rlh-token-budget-controller

English | [中文](README.zh.md)

A stop-boundary output-budget override, not a model-facing tool: it never appears in the tool list. When a turn closes on a `max-tokens` finish — the model was cut off at the output-token ceiling mid-answer — the controller overrides the stop and steers one continue nudge into the closing turn, so the model resumes where it was cut off instead of leaving the task half-written. Prior art: the token-budget meta-controller pattern (continuation with diminishing-returns detection).

Two bounds keep continuation honest:

- **Per-turn cap** — at most `maxContinuations` nudges per turn; the counter resets when the turn number changes.
- **Diminishing-returns detection** — each continuation's produced output (the step's `usage.outputTokens`) is compared against `minUsefulDeltaTokens`; after `maxLowDeltaStreak` consecutive unproductive continuations the controller stops steering, because a model that answers each nudge with near-empty output has nothing left to say. A continuation whose usage is unreported counts as productive — the cap alone bounds those.

A turn that closes on a plain `stop` finish is NOT this controller's domain and is left to other stop-boundary listeners (including `@relay-harness/rlh-behavior-correction`).

## Config

```yaml
- id: token-budget-controller
  name: '@relay-harness/rlh-token-budget-controller'
  config:
    maxContinuations: 8        # default; continue nudges allowed per turn
    minUsefulDeltaTokens: 500  # default; output tokens below which a continuation is unproductive
    maxLowDeltaStreak: 2       # default; consecutive unproductive continuations that stop steering
```

Every value fails loud at plugin load: a non-integer or sub-minimum value throws, never a silent fall-back to defaults.

## Decision and delivery semantics

The decision is a pure function of the session log read at `agent/turn-stopping`: the turn's last finish chunk must be `max-tokens`, and the per-step output series is the turn's `assistant/message` usage in order (the initial cutoff response first, one entry per continuation). The nudge rides `agent.steer(...)` as a plugin-sourced `user/message` (source `{kind: 'plugin', plugin: 'token-budget-controller'}`), so the loop re-reads its inbox and runs another step in the same turn; the message is model-visible, source-attributed, and reconstructable from the session log with no new session event.

State is per-agent and in-memory only: a `WeakMap<Agent, …>` keys the continuation counter by the live agent object and turn number. A session resumed from persistence starts with a fresh counter — the controller is a heuristic override, not a logged invariant, and one re-nudge after resume is the accepted cost. The nudge does not change `maxTokens`: the API-level ceiling still bounds each step, while the controller bounds how many continuations follow.

## Model Experience

### Continue nudge

#### What the model sees

At most `maxContinuations` plugin-sourced user messages per turn.

##### Continue nudge

```markdown
Your previous response was cut off at the output token limit, before you finished. Continue exactly where you left off: do not restart, do not summarize or repeat what you already produced, and call any tool needed to complete the remaining work.
```

#### Token effect

Zero tokens while turns finish normally. Each nudge buys one more model call; the per-turn cap and the diminishing-returns check bound total continuation spend.

#### KV Cache effect

Append-only; the nudge follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **No input-side budget** — the controller governs output continuation only; context-window pressure remains the compaction engine's domain.
- **Counters do not survive resume** — the per-turn continuation count restarts from zero after a session reload.
- **Usage is adapter-reported** — a provider that misreports `outputTokens` distorts the diminishing-returns check; unreported usage falls back to the cap.
