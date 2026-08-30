# Agent Note: knip gate scope repair

Status: implemented

English | [中文](2026-08-26-knip-gate-scope-repair.zh.md)

## Problem

`pnpm knip` was an always-red gate with drowned signal: 410 findings, of which the 114 "unlisted dependencies" were stale pre-rename `lib/` bundles still importing `@deepseek-ai/*` (knip analyzed the artifact plane), and the 184 "unused files" were `apps/desktop`'s electron entry surface that no knip workspace modeled. No CI run has ever completed on this repository, so the red was never observed. Underneath the noise sat real findings: ten unused devDependencies across six client packages and the issue orchestrator, `rlh-settings` used in production code but declared dev-only in `ui-git`/`ui-titlebar`, `zod` hidden in four per-workspace `ignoreDependencies` entries, and `@types/ws` dead in the desktop app.

## Decision

The gate analyzes the source plane through explicit workspace `entry` and `project` patterns, matching the source-plane/artifact-plane layout rule without a redundant global `lib` ignore. `apps/desktop` gets a workspace with its verified entry surface (electron preloads, HTML-loaded renderer scripts, the plugin installer hook, builder/QA/CDP scripts), and `apps/desktop/mobile` gets its own entry for the Expo shell and zero-dependency mobile web SPA. The completed rebrand codemod stays in the tree (the rename note owns that decision) and is declared a root-workspace entry. Real findings were fixed rather than suppressed: dead dependencies were removed, including seven stale `zod` declarations after the Context/Remote additions; `rlh-settings` was promoted to peer+dev in the two violating packages (the convention every sibling already follows), and `@types/ws` was removed. One honest suppression remains: `issue-automation`'s `ui-issue-orchestration` is composed via `cordis.patch.yml` bare-plugin strings knip cannot see. The `ui-git`/`ui-titlebar` per-workspace ignores added during this repair turned out to mask their real defect — `rlh-settings` declared in `dependencies` alongside peer+dev, which `verify-client-packages` names a three-way violation; removing the `dependencies` copy satisfied knip directly and the ignores were deleted.

The later outer-container move exposed two more entry classes that package scripts cannot reveal to knip: the workflow-only `scripts/build-exe-for-python-sdk.ts`, and the two QA modules loaded by name only in a source checkout. They are explicit entries. The 71 reported Desktop exports were audited rather than suppressed: `runReleaseUiWalk` and `runComposerOfficialQa` remain as the two dynamically selected QA entry functions, while 69 unused constants, helpers, and duplicate re-exports no longer widen their CommonJS or browser-module interfaces.

## Alternatives considered

**Suppress the 71 Desktop exports until a TypeScript migration.** Rejected after auditing each name: only two are selected dynamically, and declaring their files as the entries they already are preserves those interfaces without hiding unrelated dead exports.

**Leave the gate red until desktop is modeled perfectly.** An always-red gate is the same as no gate; this change takes it from broken to green-with-warnings.

## Consequences

`pnpm knip --treat-config-hints-as-errors` exits 0 without findings or configuration hints. Explicit source `project` patterns keep built bundles out of analysis, while explicit workflow/QA entries preserve dynamically reached code without suppressing their sibling exports. The one remaining per-workspace dependency suppression is the standing list of knip blind spots (cordis.yml string composition) — revisit it on knip upgrades.

## Testing

`pnpm knip --treat-config-hints-as-errors` exits 0 after the entry and export audit; Desktop tests, lint, and typecheck cover the narrowed private interfaces.
