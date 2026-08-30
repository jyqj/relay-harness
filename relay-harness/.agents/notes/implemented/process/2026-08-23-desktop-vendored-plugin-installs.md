# Agent Note: Install the desktop's vendored plugin dependencies instead of committing them

Status: implemented

English | [中文](2026-08-23-desktop-vendored-plugin-installs.zh.md)

## Problem

`apps/desktop/vendor/` carries two plugins the desktop shell bundles into its installer: the marketplace plugin `rlhmarket` and the sidebar-bot plugin `rlhbot`. electron-builder copies each tree whole through `extraResources`, so anything a plugin needs at runtime has to be on disk when the pack runs — the packaged app has no chance to fetch it later.

The tree satisfied that by committing `rlhmarket/node_modules`: 249 files of `argparse`, `js-yaml`, and `undici`, un-ignored by name against the repository-wide `node_modules/` and `dist/` ignores. That made the requirement hold, but it also made a third-party install part of the reviewed source. Nothing checked the committed files against the lockfile beside them, so a hand-edit, a partial copy, or a version that no longer matched `package-lock.json` was invisible; the vendored copy of `js-yaml` had in fact lost the executable bit npm sets on its `bin` entry. A reviewer reading a dependency-upgrade diff had to read minified vendor output to see whether it was the upgrade or something else.

## Decision

A vendored plugin's dependencies are installed, not committed. `pnpm run vendor:sync` in `apps/desktop` runs `npm ci --omit=dev --ignore-scripts` in every vendored plugin that carries a `package-lock.json`, and returns without work once each install already matches its lockfile. `scripts/vendor-installs.js` holds that logic; `scripts/run-electron-builder.cjs` and `scripts/run-electron.js` call it so packaging and `pnpm start` do not depend on a developer remembering to.

The registry is not a packaging prerequisite for correctness, only for speed. `scripts/after-pack.js` already restored the plugin's install into the packaged tree, installed from the lockfile when the packaged copy was short, and threw when the result was still incomplete. That fallback now carries the offline case: a pack on a host that cannot reach the registry fails with the missing dependency named, rather than shipping a plugin that cannot mount.

A loadable vendored plugin's *compiled* half stays committed. `rlhmarket/lib` is build output with no source in this tree, so `apps/desktop/.gitignore` un-ignores it by name. The archival `rlhbot` drop declares `lib` entry points but does not carry that subtree, has no source here, and has no published tarball. `ensureRlhbotPlugin` therefore validates `main` and every local `exports` entry before any copy, preset, link, or patch write. An incomplete package is unavailable: the installer removes an older managed copy and patch, leaves a separately installed package untouched, and does not mount the archival client-only half.

`vendor/vendor-plugins.test.js` gates the inventory rule. It fails when any path under `vendor/` that git tracks sits inside a `node_modules` directory, when a present install disagrees with its lockfile, and when a lockfile cannot resolve a dependency the plugin declares — that last one catches a lockfile that would install an unmountable plugin without needing to run the install. It also keeps every recorded missing subtree honest. The record permits an incomplete archival drop to remain; runtime admission remains stricter. The install checks skip when the working copy has not synced, which is the ordinary state of a fresh clone that only runs tests.

## Alternatives considered

**Keep committing the installs.** This is what the tree did, and it is the only option that needs no network at pack time. But packaging already requires a network install — electron and electron-builder themselves are not committed — so the commit bought offline packaging that was never actually available, at the cost of unreviewable third-party files in every diff that touched them.

**Commit the installs but add a lockfile-consistency gate.** This closes the drift hole, which was the concrete harm, and keeps pack-time behavior identical. It leaves the vendored files in review and leaves a second way to change a dependency — edit the files, re-record — that the gate can only detect after the fact.

**Install into the packaged tree only, dropping the project-level install.** `after-pack.js` can do the whole job, so `vendor:sync` is redundant for packaging. Keeping the project-level install means `pnpm start` mounts the same plugin a packaged build ships, and keeps the copy path — the one the installer actually exercises — from becoming dead code that only runs when the registry is unreachable.

**Convert the vendored plugins into workspace packages.** pnpm would then own their dependencies like any other package. Their `node_modules` layout must survive being copied to an arbitrary install directory, which a pnpm workspace's symlinked store does not; and `rlhbot` has no source here to build.

## Consequences

A dependency change to a vendored plugin is a lockfile diff. Cloning the repository does not materialize a working marketplace plugin, but the paths that need one install it, and `ensureRlhMarketPlugin` reports a missing install as `missing-source:node_modules:<names>` and leaves the plugin unmounted rather than failing Harness start.

`vendor/plugins.json` records what each drop does not carry and why. `rlhbot/lib` remains listed there because it cannot be rebuilt or refetched. Desktop starts without rlhbot, logs that the preset is not enabled, and never writes an incomplete package into the profile. The sidebar-bot and group-room suites stay skipped against that record until the complete Host half is restored.
