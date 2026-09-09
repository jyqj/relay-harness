# Agent Note: Seeded-session switch e2e misattribution and gateway slot pin

Status: implemented

English | [中文](2026-09-03-seeded-session-switch-e2e-misattribution.zh.md)

## Problem

Round-6 attributed the served-web seeded-session e2e failure (`apps/web/tests/details-session-lifecycle.e2e.ts`: clicking the runtime-seeded row makes it vanish from the Tasks group and the conversation never mounts) to the R5-B per-session operation chain in the gateway, and planned to narrow the shared slot to admission-only routes. Two facts broke that premise under instrumentation, and the flake needed a correct owner before anyone paid to fix the wrong layer.

## Decision

**The chain is exonerated by wire evidence; the pin that guards its ordering ships; the flake is re-owned.** Instrumenting `serializeSessionOperation` shows the switch path enters it never: across passing and failing runs the slot sees exactly one entry per run — the turn's own `session.prompt` admission; `agentPresets.select` and `selectModel` never enter. In failing runs the click produces zero client→host requests at all — the switch aborts client-side before any RPC — while passing runs issue the five-call switch burst (`subagent.list`, `session.history`, `dynamicCordisRunner/inventory`, `skill.list`, `commands/list`) within about 200ms, and the row leaves the list store 100–300ms after a click that already landed.

**The committed red witness was a stale build artifact.** The deterministic baseline (and the sandbox controls run against it) rode a host `lib/` whose `tsc -b` pass had skipped the final `api-proxy.ts` save — `tsdown` bundles from the stale `lib/types`, so the lane tested an earlier variant of the chain. On a fresh build the spec passes most runs, with a residual roughly one-in-five flake whose mechanism lives in the client switch flow (sessions manager / workspace tree), not in the gateway.

**What shipped:** the gateway-level pin `settles a prompt queued behind a slow swap with the swap committed first` in `packages/host/apiproxy/tests/api-proxy-agent-preset.spec.ts` (a swap parked mid-recompose while a prompt queues: both settle, the `agent-preset/selected` marker precedes the prompt's user message, and the log a projection reads names the composed preset), plus this record and the cross-linked update in the [operation-chain note](../bug-fix/2026-09-03-apiproxy-subscriber-bound-and-session-ops-chain.md). The shared slot ships exactly as R5-B left it.

## Alternatives considered

**Narrow the slot to admission-only and move `agentPresets.select` back to its own chain.** Rejected on the evidence: no select participates in the switch path, so the narrowing cannot touch the failure; it would flip the committed mid-recompose ordering from "the prompt waits and runs under the NEW composition" to "the prompt wins and the swap refuses with `agent-preset-locked`", a hero-chip UX regression traded for a fix aimed at nothing.

**Chase the residual flake inside this slice.** Rejected for ownership: the observed mechanism — click lands, no RPC follows, the row drops from the store without wire traffic — sits in the sessions manager and workspace tree, outside this slice's file set. A follow-up slice owning `packages/client/runtime/src/client/sessions/` and `packages/client/ui-workspace/` should take it with the wire-capture method above.

## Consequences

The details-session-lifecycle lane still fails intermittently (~1 in 5); it is no longer evidence against the gateway chain, and its red no longer blocks on this slice. The admission-ordering pin fails loud if the mid-recompose ordering regresses in either direction. One durable caution: the web e2e lane runs the host from built `lib/` — after changing host source, run `npm run build:lib:host` or the lane tests yesterday's bundle and the failure misattributes again.
