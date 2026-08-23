# Agent Note: Desktop app position and static gates

Status: implemented

English | [中文](2026-08-23-desktop-app-position-and-gates.zh.md)

## Problem

`apps/desktop` is the largest single body of code in the repository that no static gate reads. It is roughly 38,000 lines of plain JavaScript across 96 non-test files, and until this change the only automated signal over it was `node --test`. The root oxlint configuration is type-aware, which is why it ignores `**/*.js` outright, and the desktop is in no TypeScript project, so neither `pnpm run lint` nor `pnpm run typecheck` ever saw it. A rename that missed a `require` path, or a function left dead by a refactor, surfaced only when a user launched the app.

The [Relay Harness rename](../process/2026-08-23-relay-harness-rename.md) made the gap concrete: renaming `install-rlh-plugin-client.js` moved a module every `require` in the tree had to follow, with nothing but the test suite to catch a miss.

Its position was also unsettled. The repository now hosts a Relay product-documentation layer above the harness ([ADR-0005](../../../../../docs/adr/0005-adopt-ts-harness-runtime.md)), which raises whether the Electron shell is a harness application or a Relay product shell that should sit at the outer repository root.

## Decision

The desktop app stays at `apps/desktop`, inside the harness pnpm workspace, and joins the repository's static gates rather than moving.

### Position

The shell is an application over the harness, not a peer of it. In a source launch [`harnessRoot()`](../../../../apps/desktop/src/main/paths.js) resolves the harness as `apps/desktop/../..`, `setup:harness` builds through `pnpm --dir ../..`, and every root convenience script drives it with `pnpm --filter relay-harness-desktop`. `apps/*` is a workspace glob, so the shell shares the root lockfile, the pinned Electron toolchain, and one install.

Hoisting it to the outer repository root would sever all of that: a second install root and lockfile, a rewritten harness-root resolution for both source and packaged modes, and CI lanes that can no longer reach it through the harness workspace. That buys a repository boundary with no owner on the other side. Relay's runtime *is* this harness, so the shell and the runtime it launches belong to one install.

### Static gates

Three gates cover the shell, all runnable from the repository root and all wired into the CI static lanes beside the existing desktop test gate:

| Gate | Script | What it reads |
|---|---|---|
| `desktop-tests` | `pnpm run test:desktop` | `node --test` suites |
| `desktop-typecheck` | `pnpm run typecheck:desktop` | `tsc` over the opted-in files |
| `desktop-lint` | `pnpm run lint:desktop` | type-independent oxlint rules |

[`apps/desktop/tsconfig.json`](../../../../apps/desktop/tsconfig.json) sets `checkJs: false`, so type checking is opted into **per file** with a leading `// @ts-check` pragma. 67 of the 96 non-test files carry it today because they were already clean; the remaining 27 are not yet annotated. A file with the pragma is a gate and must stay clean. Widen the coverage by fixing a file's types and adding the pragma in the same change; never remove a pragma to make a change compile. `src/main/release-ui-walk.js` and `src/main/composer-official-qa.js` are excluded outright — they are release QA scripts evaluated inside a live Electron page, and the packaged build already omits them.

[`apps/desktop/.oxlintrc.json`](../../../../apps/desktop/.oxlintrc.json) is a separate configuration rather than an exception carved into the root one, because the root config's `typeAware: true` is exactly what makes plain JavaScript unlintable there. Turning it on found 16 real problems, including a dead `asCwd` in `workspace-fs.js` and a `throw` inside a test's `finally` block that would have replaced any assertion failure in that test with a cleanup error.

### The vendored `node_modules` stay tracked

[`apps/desktop/vendor/rlhmarket/node_modules`](../../../../apps/desktop/vendor/rlhmarket/README.md) holds 249 tracked files — `undici`, `js-yaml`, and `argparse`, about 2.7 MB. They are load-bearing, not residue. [`rlhmarket-preset.js`](../../../../apps/desktop/src/main/rlhmarket-preset.js) copies the whole vendored tree into the user's web profile and fails closed when a declared runtime dependency is missing, stripping its managed `cordis.patch.yml` block so the Loader never mounts a half-installed plugin. Untracking them would make a first launch depend on a network install and would break the electron-builder `extraResources` path that ships the market offline.

## Alternatives considered

**Move the shell to a top-level `apps/desktop` as the Relay product shell.** The strongest case: Relay's product surface is the desktop app, and the outer repository is where Relay lives. It loses to the coupling above — harness-root resolution, the shared lockfile and Electron pin, and the CI lanes all assume one workspace — and the split would need an owner for a boundary that has no second team behind it. Revisit if Relay ever ships a shell that does not embed this harness.

**Extract it into its own package with a real build pipeline (bundling, transpilation).** The shell is CommonJS loaded directly by Electron with no build step, which is why a source launch is instant and a stack trace points at the file you edited. A bundler would buy tree-shaking for an app whose size is dominated by Electron itself, and would cost that directness. The typecheck this change adds gets most of the safety a build step is usually wanted for.

**Convert the shell to TypeScript.** The honest endpoint, and not reachable in one step across 38,000 lines. The `// @ts-check` ladder is the same type system applied incrementally with no syntax migration and no build step, and it can run to completion — all 96 files annotated — before anyone has to decide whether `.ts` files are worth a compile stage.

**Enable `checkJs` repository-wide for the app and suppress the 126 failures.** Rejected because a suppression list is not a gate: it grows silently, and nothing distinguishes a file nobody has cleaned from a file someone gave up on. Per-file opt-in inverts that — the annotated set only grows, and an un-annotated file is an honest "not yet".

**Add the desktop globs to the root `.oxlintrc.json`.** The root config's value is its type-aware rules, which cannot run over files outside a TypeScript program. Un-ignoring `**/*.js` there would either weaken the config for the TypeScript tree or force per-glob overrides that read as exceptions to a rule that does not apply. A separate config states the situation plainly.

**Untrack the vendored `node_modules` and install them at package time.** Attractive for repository size, but it converts a first launch and every offline packaging run into a network operation, for 2.7 MB. Reconsider if the market plugin ever gains a build step of its own.

## Consequences

The desktop now fails CI for a broken `require` path, a dead export, or a type error in an annotated file — the class of breakage the rename could have shipped silently. The three gates read only `apps/desktop` and need no build artifact, so they run straight after install in the static lanes and add no ordering constraint.

Type coverage is partial and visibly so: 27 files carry no pragma, and the count is the honest measure of how far the migration has to go. Nothing forces it forward, so the ladder can stall unless changes to those files pay down their own types.

Keeping the shell in the harness workspace means the outer Relay layer still has no application of its own — the product documentation at the repository root describes a shell that lives one directory down. That mismatch is real and stays open until Relay ships product code rather than only product docs.
