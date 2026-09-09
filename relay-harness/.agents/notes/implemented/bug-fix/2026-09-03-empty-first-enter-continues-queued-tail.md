# Agent Note: A first enter rewritten empty still claims the queued inbox tail

Status: implemented

English | [中文](2026-09-03-empty-first-enter-continues-queued-tail.zh.md)

## Problem

When an `agent/pre-step` waterfall rewrote the first enter decision of a turn to zero messages, `ReactLoopAgent.turn()` returned `false` straight from the pre-step check in `packages/core/agent-loop/src/agent.ts`. That exit was unique: every other turn exit flowed through the driver tail that re-checks `inbox.hasPending` and continues with a fresh turn when work remains. A message queued while the driver was live is latched nowhere — `send()` during a running phase deliberately leaves `wakeRequested` unset because the live driver claims the queue itself — so the skipped tail left the queued message stranded: `send('a'); send('b')` with an empty-enter listener claimed `a`, closed turn 1, and shelved `b` in the inbox until some later external wakeup, contradicting the documented turn contract that a turn closes once nothing is owed.

## Decision

The empty-first-enter exit sets `turnEnds` to `{ kind: 'completed' }` and breaks to the shared tail instead of returning early, exactly like the sibling no-step exit that closes a spent turn with no claimed messages. When the inbox holds pending work, the tail resets the driver's abort controller and `turn()` returns `true`, opening a fresh turn that claims the next queued message; when it holds nothing, the tail returns `false` and the driver converges as before.

## Alternatives considered

- **Latch a wake when the driver exits after an empty first enter** — rejected: it routes the continuation through the convergence replay one hop later and special-cases one exit, while the sibling no-step exit already proves the tail path is the correct shared continuation.
- **Treat a rewrite to empty as a `reject` decision** — rejected: the two decisions mean different things to listeners, and the durable-log contract (a real turn with `turn/end` `completed` that spent no step) is already pinned by tests and docs for the empty-enter case specifically.

## Consequences

- `docs/architecture.md` needs no change: the turn-flow contract ("a first enter rewritten empty -> close the turn with no step"; "closes once nothing is owed") already describes the fixed behavior; the code was the deviation.
- No session-log format change: the continuation is an ordinary `turn/start` / `turn/end` pair, and the no-queued case logs byte-identical events to before.
- The TypeScript and Python SDK expected outputs are unaffected: neither replays an empty-enter rewrite with a queued tail.

## Testing

- `packages/core/agent-loop/tests/contract-regressions.spec.ts` adds "continues the queued tail after an empty admitted batch as its own turn" next to the existing empty-batch case: two queued followups with a turn-1-only empty-enter listener must produce one no-step turn followed by a real turn 2 with `step/start { turn: 2, step: 1 }`, one model request, and an empty inbox. It failed before the fix (zero requests, one turn) and passes after.
- `pnpm vitest run packages/core/agent-loop packages/core/agent` — 456 tests, all green.
