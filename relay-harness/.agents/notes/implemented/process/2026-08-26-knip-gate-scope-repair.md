# Agent Note: knip gate scope repair

Status: implemented

English | [中文](2026-08-26-knip-gate-scope-repair.zh.md)

## Problem

`pnpm knip` was an always-red gate with drowned signal: 410 findings, of which the 114 "unlisted dependencies" were stale pre-rename `lib/` bundles still importing `@deepseek-ai/*` (knip analyzed the artifact plane), and the 184 "unused files" were `apps/desktop`'s electron entry surface that no knip workspace modeled. No CI run has ever completed on this repository, so the red was never observed. Underneath the noise sat real findings: ten unused devDependencies across six client packages and the issue orchestrator, `rlh-settings` used in production code but declared dev-only in `ui-git`/`ui-titlebar`, `zod` hidden in four per-workspace `ignoreDependencies` entries, and `@types/ws` dead in the desktop app.

## Decision

The gate now analyzes the source plane only: root-level `ignore: ["**/lib/**"]` removes build artifacts from every workspace, matching the source-plane/artifact-plane layout rule. `apps/desktop` gets a workspace with its verified entry surface (electron preloads, HTML-loaded renderer scripts, the plugin installer hook, builder/QA/CDP scripts), and `apps/desktop/mobile` gets its own entry for the Expo shell and zero-dependency mobile web SPA. The completed rebrand codemod stays in the tree (the rename note owns that decision) and is declared a root-workspace entry. Real findings were fixed rather than suppressed: ten dead devDependencies removed, `rlh-settings` promoted to peer+dev in the two violating packages (the convention every sibling already follows), `@types/ws` removed, `zod` de-ignored. One honest suppression remains: `issue-automation`'s `ui-issue-orchestration` is composed via `cordis.patch.yml` bare-plugin strings knip cannot see. The `ui-git`/`ui-titlebar` per-workspace ignores added during this repair turned out to mask their real defect — `rlh-settings` declared in `dependencies` alongside peer+dev, which `verify-client-packages` names a three-way violation; removing the `dependencies` copy satisfied knip directly and the ignores were deleted.

Desktop's 71 unused exports are reported at `warn` severity via root `rules.exports` — visible every run, non-blocking — because the untyped JS world needs its own dead-export cleanup before enforcement, not a silent pass.

## Alternatives considered

**Enforce exports as errors and delete the 71 desktop exports now.** The electron main process loads modules through dynamic paths (packaged-resource lookups, plugin runtimes) that static analysis cannot fully see; bulk deletion without that knowledge risks runtime breakage for a gate win. Deferred to the desktop TS migration.

**Leave the gate red until desktop is modeled perfectly.** An always-red gate is the same as no gate; this change takes it from broken to green-with-warnings.

## Consequences

`pnpm knip` exits 0 with 71 warning-level findings, all in `apps/desktop` and `mobile/web` — the quantified dead-export backlog of the untyped world, visible on every hygiene run. The exports rule is a ratchet: flip it back to error once the desktop cleanup lands. Root-level `ignore: ["**/lib/**"]` also means freshly built bundles can never pollute findings again. The one remaining per-workspace dependency suppression is the standing list of knip blind spots (cordis.yml string composition) — revisit it on knip upgrades.

## Testing

`npx knip` exits 0 after clearing `node_modules/.cache/knip`; the edited packages' suites pass (`ui-git`, `issue-orchestrator`: 13 files, 156 tests); `pnpm install` re-synced the lockfile after the dependency removals.
