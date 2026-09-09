# Agent Note: Claude Code Stop-hook loop guard

Status: implemented

English | [中文](2026-09-03-claude-code-stop-loop-guard.zh.md)

## Problem

The hooks-claude-code bridge steered on every merged Stop-hook deny with no counter: an `agent/turn-stopping` deny repopulates the inbox inside the same turn's loop, so each deny spent another model request with no bound — an always-deny hook in an untrusted `hooks.json` looped until abort, burning unbounded provider spend. The bridge also hardcoded `stop_hook_active: false` in every Stop payload, so a Claude Code hook had no way to observe its own forced continuation and self-limit. The codex bridge had already shipped the once-per-turn guard; only the Claude Code dialect carried the gap.

## Decision

The Stop listener in hooks-claude-code now tracks, per agent, the turn number of its most recent forced continuation in a `WeakMap`. A Stop check in that same turn reports `stop_hook_active: true` in the stdin payload, and if it still denies, the bridge logs `remained blocking … closing the turn` and returns without steering — the turn closes after exactly one forced continuation. A deny in a turn the bridge has not yet continued steers as before and records the turn. SubagentStop payloads keep `stop_hook_active: false`, matching the codex bridge.

One forced continuation per turn is Claude Code's own `stop_hook_active` protocol semantics, so this is a protocol-parity fix rather than a new policy, and no Config field gates it. A hook that legitimately needs another block in a later turn still gets one, because the guard keys on the turn number.

## Alternatives considered

**Count consecutive denies across turns.** Rejected: the deny loop that matters is within one turn, and Claude Code's documented contract is per-turn (`stop_hook_active` is false again on the next turn's first Stop check). A cross-turn cap would also strand tasks that legitimately re-block across turn boundaries.

**Add a numeric cap as a Config field.** Rejected for now: the protocol value is 1, not a deployment-varying choice. If a deployment ever needs a different cap, that becomes a validated Config field then.

## Consequences

A Stop hook that denies twice within one turn now closes the turn instead of forcing a second step — the same behavior the codex bridge already shipped, closing the dialect asymmetry. Hook-payload logs record `stop_hook_active: true` on second same-turn checks, and hook payloads for a forced continuation change observably. Existing hook configs that relied on unlimited same-turn force-continuation must self-limit (exit 0 on the repeat check) as Claude Code's own protocol expects. The gap that remains is the shared `TODO(hook-continue-false)`: a `{"continue": false}` outcome is still recorded but does not halt the run.
