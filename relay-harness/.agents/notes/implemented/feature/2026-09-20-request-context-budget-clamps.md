# Agent Note: Request-local context budget clamps

Status: implemented

English | [中文](2026-09-20-request-context-budget-clamps.zh.md)

## Problem

Deployment-side context budgets (`ContextEngine` config) bounded what the engine packs, but a caller could not declare a smaller allowance for one request, and no wall-clock deadline could travel with a step. Effective context budgets therefore exceeded what the requesting consumer actually wanted or could still afford. The memory recall Consumer rendered against its own configured cap only, so a large request allowance let recall grow past the caller's budget, and hits that could not fit were silently described as "no memory" instead of a classified budget decline.

## Decision

`ContextPrepareInput` accepts optional `limits` (`Partial<ContextBudget>`) and `deadlineAt`. Planning resolves the total allowance as the minimum of the deployment config, the request `limits`, and — for explicit retrieval — the retrieval budget; `limits` and `budget` can only lower the deployment values, never raise them, and non-positive or non-integer `limits` fail with `CONTEXT_ENGINE_INVALID_CONFIG` before any provider runs. The preparation deadline becomes the earlier of `prepareTimeoutMs` and `deadlineAt`; each eligible provider already receives `budget.timeoutMs: max(0, deadlineAt - now)` and the absolute `budget.deadlineAt`, so a caller deadline propagates to every provider budget unchanged.

The memory recall Consumer clamps its rendering allowance to `min(maxContextChars, budget.maxChars, max(0, (budget.maxTokens - 4) * 4))` — the deployment cap tightened by the request's character and estimated-token budget with framing overhead reserved. When hits exist but the remaining allowance admits none — including the framing alone not fitting — the contributor declines with `ContextProviderError('declined', 'budget_exhausted')`, which the engine records as a rejection trace instead of a silent no-memory outcome; a genuine empty search still declines without a reason.

## Alternatives considered

**Per-request budget fields on every contributor.** Each Consumer re-deriving its own clamping invites drift; the engine owns total-budget resolution once, and contributors only tighten further.

**Raising the deployment budget when `limits` is larger.** Rejected: a request is never more trusted than deployment configuration; the clamp is one-directional by design.

**Silently dropping unfit recall hits (previous behavior).** A caller cannot distinguish "no memory exists" from "memory did not fit", and the missing `budget_exhausted` classification hid real budget pressure from the trace.

## Consequences

Callers that pass `limits` get strictly tighter or equal budgets; existing callers that omit the new fields see unchanged behavior except that the memory recall message may now be smaller than `maxContextChars` under tight request budgets, and oversized-hit recall requests surface as `declined/budget_exhausted` decisions rather than quiet omissions. A caller deadline shorter than `prepareTimeoutMs` can starve providers that would have finished; the trace records `deadline` exactly as a configured timeout does.

## Verification

`packages/context/context-engine/tests/native-retrieval.spec.ts` pins purpose exclusion, aggregate per-provider charging across candidates, equal-rank identity ordering, limit lowering/raising/invalid rejection, and deadline propagation with an already-expired deadline. `packages/memory` tests cover recall rendering and settlement; the two code-context suites importing removed `session-query`/`memory-extractor-llm` deep paths fail on the base branch and are unrelated to this change.
