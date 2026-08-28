# Agent Note: Code-index tool consumer — model surface before providers

Status: implemented

English | [中文](2026-08-27-code-index-tools.zh.md)

## Problem

The local code-index capability ([seam](2026-08-27-local-code-index-seam.md), [search engine](2026-08-27-code-index-search-engine.md), [SQLite store](2026-08-27-code-index-sqlite-store.md)) had no model-visible Consumer, so no deployment could exercise retrieval end to end. The tools also needed the reference implementation's single-exit output budget (`output_budget.rs`) ported natively rather than re-scattered per handler, and a decision on how tools behave in compositions where the provider plugin is not yet loaded.

## Decision

Add `@relay-harness/rlh-tool-code-index` under `packages/index/`: `search_code_index`, `code_index_status`, and `refresh_code_index`.

- The seam stays OPTIONAL. Static injection would block composition on a missing provider; instead each execute resolves `ctx.get('codeIndex')` and fails structured (`INDEX_TOOL_UNAVAILABLE`), which turns a missing plugin into an ordinary model-readable error at the earliest resolvable point — the first call — without gating unrelated tools.
- Exit budgeting is one ported module: `ExitPolicy` union plus `applyExitPolicy`. search is byte-capped by `repoSizeTierMaxOutputChars(answer.tier)` read AFTER execution (the answer carries the tier); status and refresh are passthrough by construction. The envelope's `partial` degrades to the bounded preview STRING when reparsing fails — the reference's original-value fallback is deliberately NOT carried over because it defeated its own cap.
- Refresh adds a tool-side busy guard on top of the seam's fold semantics: while this plugin awaits a pass, further calls get `INDEX_TOOL_REFRESH_IN_PROGRESS` immediately instead of queueing for an identical second summary after commit.

Prompt guidance ships as one fixed section (`tool:code-index`, order 107) quoting when to prefer indexed retrieval over grep/glob and how to handle staleness through epochs.

## Alternatives considered

- **Rejecting duplicate refreshes inside the provider** — rejected for now: the seam's contract already folds concurrency, and building a second queue there would either duplicate this guard or contradict it; the tool-level guard keeps the model-facing semantics visible where the model can read them.
- **Gating registration on seam presence** — rejected: it would couple an unrelated deployment's ability to load its other tools to an optional capability, the exact failure mode the `ctx.get` convention exists to avoid.

## Consequences

Catalog wiring followed the established checklist: a `TOOL_PACKAGES` boot recipe with a rejecting stub provider feeds schema harvest; READMEs link the generated `relay-harnessrlh-tool-code-index` anchor. Two divergences from the reference worth keeping visible: the byte budget measures UTF-8 bytes though the tier constant says "chars", and the advisory `includeGrep` field rides outbound ahead of the seam type growing it.
