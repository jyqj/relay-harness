# @deepseek-ai/dsh-behavior-correction

English | [中文](README.zh.md)

A stop-boundary behavior corrector, not a model-facing tool: it never appears in the tool list and never vetoes a call. It watches each agent's `agent/turn-stopping` boundary and, when the closing turn ended on a model behavior deviation, steers exactly one corrective message into the turn so the model re-enters the loop instead of ending on the deviation. The decision stays with the model; every cap lets the turn close. Prior art: GenericAgent's `do_no_tool` correction layer.

Three deviations are detected, in this inspection order:

- **Empty answer** — the closing assistant message carries no visible text (a degenerate completion the adapter did not already classify as `EMPTY_RESPONSE`, e.g. whitespace-only output). Consecutive empty closings are counted across turns; at `maxConsecutiveEmpty` the guard gives up and lets the turn close, because a model that keeps answering empty will not be fixed by another identical nudge.
- **Unexecuted code** — the closing answer contains a fenced code block in a turn that made no tool call. Describing a command or edit does not perform it; the correction tells the model to call the tool or conclude without the block.
- **Unverified completion** — the closing answer matches a completion-claim pattern in a turn that made no tool call, while an earlier turn of the same session did. The correction asks for a verifying tool call or a justification, which suppresses "declared done with no evidence" endings in work sessions without touching pure chat sessions (no prior tool activity, no challenge).

A turn that closes on a `max-tokens` cutoff is NOT a deviation and is left to `@deepseek-ai/dsh-token-budget-controller`; a turn with any tool call in it is never challenged for code blocks or completion claims.

## Config

```yaml
- id: behavior-correction
  name: '@deepseek-ai/dsh-behavior-correction'
  config:
    maxCorrectionsPerTurn: 1       # default; corrections allowed per turn across all detectors
    maxConsecutiveEmpty: 3         # default; consecutive empty closings tolerated before giving up
    emptyAnswer: true              # default; detector toggle
    unexecutedCode: true           # default; detector toggle
    unverifiedCompletion: true     # default; detector toggle
    completionPatterns: [...]      # default English and Chinese claim phrases, matched case-insensitively
```

Every value fails loud at plugin load: a non-integer or sub-minimum cap, an empty pattern, a pattern that does not compile, or an empty `completionPatterns` list while `unverifiedCompletion` is enabled all throw, never a silent fall-back to defaults. An empty `completionPatterns` list is valid when `unverifiedCompletion` is off.

## Detection and delivery semantics

Detection is a pure function of the session log read at the stop boundary: the turn's last finish chunk must be a plain `stop`, the closing assistant message is the turn's last, and tool activity is counted per turn (`tool/call` events). Corrections ride `agent.steer(...)` as a plugin-sourced `user/message` (source `{kind: 'plugin', plugin: 'behavior-correction'}`), so the loop re-reads its inbox and runs another step in the same turn; the message is model-visible, source-attributed, and reconstructable from the session log with no new session event.

State is per-agent and in-memory only: a `WeakMap<Agent, …>` keys correction counts by the live agent object and turn number, so one agent's deviations never consume another's budget and object lifetime bounds the entry. A session resumed from persistence starts with fresh counters — the guard is a heuristic nudge, not a logged invariant, and an occasional re-correction after resume is the accepted cost. When several plugins listen on the same boundary, data decides: this guard never fires on a `max-tokens` finish and the token budget controller never fires on a `stop` finish, so listener order cannot produce competing steers.

## Model Experience

### Corrective context message

#### What the model sees

At most `maxCorrectionsPerTurn` plugin-sourced user messages per turn, each naming one deviation.

##### Empty-answer correction

```markdown
Your previous response was empty: it contained no text and no tool calls. If the task is complete, state the result explicitly; otherwise continue working on it.
```

##### Unexecuted-code correction

```markdown
You produced a code block but did not call any tool, so nothing was executed. Describing a command or edit does not perform it. If the code was meant to run, call the appropriate tool now; if the task is already complete, conclude without the code block.
```

##### Unverified-completion correction

```markdown
You declared the task complete, but this turn made no tool call that verifies the result. Before concluding, verify with a tool call (run the tests, re-read the changed file, or check the effect). If you are certain no verification is needed, explain why.
```

#### Token effect

Zero tokens while no deviation occurs. A correction is one short message, retained history for that agent, and bounded per turn.

#### KV Cache effect

Append-only; the correction follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Heuristics, not understanding** — fenced blocks in explanatory prose can false-positive the unexecuted-code detector, and the completion patterns cannot read intent; the caps bound the cost to one extra message per turn.
- **Counters do not survive resume** — per-turn and consecutive counts restart from zero after a session reload.
- **No cross-turn completion tracking** — the unverified-completion detector judges the closing turn only; a claim spread across turns is out of scope.
