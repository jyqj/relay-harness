# Agent Note: Stop-boundary guards

Status: implemented

English | [中文](2026-08-21-stop-boundary-guards.zh.md)

## Problem

The loop trusted the model's own stop decisions. Three deviation classes ended turns silently: an empty closing answer (degenerate output the adapter did not classify as `EMPTY_RESPONSE`, e.g. whitespace-only text), a fenced code block produced in a tool-free turn (the model "described" execution instead of performing it), and a completion claim with no verifying tool activity in the closing turn. A fourth case was the mirror image: a turn cut off at the output-token ceiling ended with the task half-written, because `max-tokens` was sticky and nothing overrode it. The `guard/` family had per-call hygiene (repeat detection, tool timeouts) but nothing watching the stop boundary, where all four deviations actually commit.

## Decision

Two new guard plugins listen on `agent/turn-stopping`, partitioned by the turn's closing finish kind so listener order cannot matter. `@relay-harness/rlh-behavior-correction` acts only on a plain `stop` finish: it detects the three deviations (in inspection order: empty answer, unexecuted code, unverified completion) and steers one corrective message into the closing turn via `agent.steer(...)`, bounded per turn and, for empty answers, by a consecutive-streak give-up. The unverified-completion detector requires zero tool calls in the closing turn plus tool activity in an earlier turn, so pure chat sessions are never challenged. `@relay-harness/rlh-token-budget-controller` acts only on a `max-tokens` finish: it steers a continue nudge, bounded by a per-turn continuation cap and by diminishing-returns detection over the turn's per-step `outputTokens` series (unreported usage counts as productive; the cap alone bounds those).

Both plugins are pure functions of the session log at the boundary — finish kind, closing assistant message, per-turn tool-call counts, and usage are all read from events — so the only owned state is per-agent in-memory counters in a `WeakMap`, documented as not surviving resume. Corrections ride the existing logged steer channel (`user/message` with a plugin source), so model-visible ⟺ logged holds with no new session events.

## Alternatives considered

- **One plugin for both boundaries.** The two decision surfaces share nothing but the extension point; separate packages keep each config and README honest, and the finish-kind partition makes their composition order-independent.
- **Veto instead of steer** (reject the closing step and force a retry). A veto rewrites history the model already produced; steering keeps the deviation visible and lets the model correct itself, which is the behavior the reminders train.
- **Durable counters.** Persisting correction counts would survive resume at the cost of new session events and fork semantics; the guards are heuristic nudges, and an occasional re-correction after resume is cheaper than the format surface.
- **Hard iteration caps instead of diminishing-returns detection.** A fixed cap alone keeps paying for continuations that produce near-empty output; the streak check stops exactly when continuation stops being useful.

## Verification

Each package drives a real agent loop against a scripted mock adapter: deviation detection per class, detector suppression (tool-active turns, chat sessions, max-tokens crosstalk in both directions), per-turn and consecutive caps, continuation reset on a new turn, unreported-usage handling, and fail-loud config validation. Both packages meet the per-file 100% coverage gate.

## Consequences

Turns can no longer close silently on the three deviations or on an unfinished cutoff; the cost is at most one corrective message per turn per plugin, bounded by caps that always let the turn close. Subagents inherit the behavior through the same boundary, which is desirable: delegated turns get the same hygiene. Operators can tune or disable each detector per deployment via cordis.yml without touching code.
