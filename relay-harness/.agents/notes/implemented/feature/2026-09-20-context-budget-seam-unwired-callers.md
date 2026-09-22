# Agent Note: Agent-step callers leave the context budget seam unwired

Status: implemented

English | [中文](2026-09-20-context-budget-seam-unwired-callers.zh.md)

## Problem

The request-local `ContextPrepareInput.limits` and `deadlineAt` fields ([request-local context budget clamps](2026-09-20-request-context-budget-clamps.md)) had no caller on the agent STEP path: `ReactLoopAgent.preStep` and the Prompt Enhancement Context Engine adapter invoked `prepareStep` without either field. Wiring them was proposed so the engine's caller-facing seam would have production coverage, but neither caller owns a fact to pass: the agent loop has no step wall-clock deadline anywhere (no step timeout in `agent-loop` `Config`, none in `AgentOptions`, no `stepTimeout`/`turnTimeout` concept in the repository), and no loop config bounds step context size. The step's only cancellation channel is the abort signal, which `prepareStep` already receives. The nearest existing budget authority, the shipped-base `token-budget-controller`, bounds turn structure (`maxStepsPerTurn`, continuation caps), not wall-clock time or prepared-context size.

## Decision

Both callers stay unwired, and tests pin that state: the agent-loop step-context suite and the prompt-enhancement-context-engine provider suite assert the `prepareStep` input carries neither `limits` nor `deadlineAt` and that the step behaves exactly as before. The engine's own validated `Config` remains the single authority over preparation bounds — `prepareTimeoutMs` resolves the deadline (`min(engine, caller)` already folds an absent caller deadline to the engine value) and `maxChars`/`maxTokens` resolve the ceiling — so every deployment already tunes preparation through `context-engine` config without a second knob.

`retrieve_context` keeps its `budget` field, whose source is the tool-context policy `Config`; that path is out of scope here.

## Alternatives considered

**Adding a `stepDeadlineMs` loop config and forwarding `Date.now() + stepDeadlineMs`.** No current consumer or prior art asks for a per-step deadline distinct from the engine's `prepareTimeoutMs`; the new tunable would duplicate the engine's own deadline with a second home for one fact and change loop behavior whenever set, violating the evidence rule for public choices.

**Forwarding a constant ceiling or a fixed deadline "so the seam has coverage".** A fake constant misstates caller intent, can only silently tighten or lie about budgets, and the seam's coverage already exists where a real source lives (tool-context `budget`, memory recall clamps).

## Consequences

The two optional fields remain without an agent-step caller; a future loop feature that genuinely owns a wall-clock budget (for example a configured step timeout) can adopt `deadlineAt` by deleting the pinned assertion alongside its feature tests. Nothing about the step path changed at runtime: absent deadline config behaves byte-identically, which the same assertions guard by keeping the full step (claim, prepare, model call) green.

## Verification

`packages/core/agent-loop/tests/step-context.spec.ts` ("supplies no per-request budget ceiling or deadline …") asserts the missing fields on the recorded `prepareStep` input and the unchanged request text. `packages/context/prompt-enhancement-context-engine/tests/provider.spec.ts` ("delegates preparation without a caller budget ceiling or deadline …") makes the same assertions for the `prompt_enhancement` purpose. `vitest run packages/core/agent-loop packages/context/prompt-enhancement-context-engine packages/context/context-engine` is green and `tsc -b` passes for both touched packages.
