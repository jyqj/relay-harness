# Agent Note: hygiene gate single source

Status: implemented

English | [中文](2026-08-26-hygiene-single-source.zh.md)

## Problem

The hygiene check existed twice. The root `package.json` `hygiene` script chained thirteen verify commands sequentially, while `scripts/run-gates.ts` carried `hygieneLeafGates()` — a overlapping ten-gate list with dependency metadata that the CI aggregates embed. The two lists had already drifted (the npm script included `verify-cordis-config`, `verify-runtime-closure`, and `verify-vendored-links`; the gate list did not), and every new check had to be added in two places or the surfaces silently diverged. Worse, the gate had never actually been green: four of its members (`verify-node-next-types`, `verify-runtime-closure`, `rescope-vendor:check`, `verify-client-packages`) failed on an untouched tree — no CI run has ever completed on this repository, so the sequential script's red was as invisible as the drift.

## Decision

`hygiene` is now `tsx scripts/run-gates.ts hygiene`: a new `hygiene` mode in the gate graph returning `hygieneLeafGates()` plus the three checks the npm script carried, so the list lives once. The mode runs under the local concurrency cap (4 workers) like the other local aggregates. The four red members were repaired rather than suppressed: vendored ghostty sources gained the `.ts` extensions their extensionless relative imports needed for NodeNext declaration emit; `python/sdk-runtime` declared the memory family (`rlh-memory`, `rlh-memory-agent`, `rlh-tool-memory`) its preset closure requires; `rescope-vendor --apply` landed the two residue edits it reported (`after-pack.test.js` preset path scoping and the vendored market lockfile); and `verify-client-packages`' systematic violations were fixed at the declaration level — eleven packages moved static client inputs (`react`, `ui-primitives`, `ui-slots`) out of `peerDependencies` to dev-only, and three-way `dependencies`+peer+dev declarations of `rlh-settings`/`rlh-app-boot` were reduced to the peer+dev convention.

## Alternatives considered

**Keep the sequential script and patch its four failures.** Sequential `&&` chains run one-at-a-time, report no per-check labels, and would still be a second list to keep in sync. Lost to the gate graph.

**Defer the member repairs to their own changes.** The gate graph change and the repairs verify each other: a single-source gate that is red proves nothing about drift. Landing them together makes `pnpm run hygiene` green-and-single-sourced in one reviewable step.

## Consequences

`pnpm run hygiene` runs thirteen checks in one dependency-aware pass and exits 0; adding a check is a one-line change in `run-gates.ts` that CI and local runs see simultaneously. The `verify-client-packages` batch surfaced that the static-input rule (dev-only for inputs statically linked into client bundles) had never been enforced repo-wide — the eleven-package correction is the backlog that rule had accumulated. `run-gates.spec.ts` gained `hygiene` in its mode matrix.

## Testing

`pnpm run hygiene` reports 13 passed, 0 failed; `scripts/run-gates.spec.ts` passes (52 tests); the touched packages' suites pass (`ui-user-terminal` 166 tests, desktop `after-pack.test.js` 21 tests); `verify-node-next-types` reports 273 packages compiling under NodeNext.
