# Agent Note: Locked desktop vendor installs

Status: implemented

English | [中文](2026-09-05-locked-desktop-vendor-installs.zh.md)

## Problem

An immutable workspace install does not fix desktop plugin dependencies if packaging can fall back to `npm install`, reuse a drifted install, or accept lock entries without archive resolution and integrity. Missing compiled plugin code is a separate condition that a lockfile cannot repair.

## Decision

The [desktop vendor installer](../../../../apps/desktop/vendor/README.md) requires a regular version-3 npm lock whose identity and dependency declarations match the manifest. Production entries carry fixed HTTPS resolutions and integrity. A missing or inconsistent lock fails before an existing install is removed. Release packaging always runs `npm ci` with development dependencies omitted, scripts disabled, peer auto-installation disabled, and workspace discovery disabled, then verifies runtime entry files. Development sync may reuse a matching install, but not a missing lock or version drift.

The marketplace's three production dependencies are locked to `argparse` 2.0.1, `js-yaml` 4.3.1 within its declared range, and `undici` 7.29.0. Missing archive metadata is reconstructed only from the existing root lock and cache tarballs whose SHA-512 values and package identities match, then normalized and verified by offline npm. Its compiled `@relay-harness/schemastery` import is declared as a Host peer at the locally verified `^3.18.1` API line. Host settings and schema code are shared, never copied as a second runtime.

The private `rlhbot` package has a genuinely generated zero-production-dependency lock because it declares only Host peers. Its recorded missing Host `lib` remains unavailable and excluded from installable plugins; the lock does not fabricate code or enable the optional feature.

## Alternatives considered

- **Keep unlocked fallback installation** — release contents can change while the application source and manifest stay unchanged.
- **Use placeholder integrity or reconstruct a registry tarball from installed files** — neither proves the original published archive bytes.
- **Auto-install Host peers into each plugin** — creates second SDK/Cordis identities rather than using the existing Host.
- **Treat a lockfile as evidence of complete plugin code** — hides the independently known missing private Host entry.

## Consequences

Packaging requires the locked archives to be reachable or already cached and fails closed otherwise. Script suppression remains unconditional. Two clean offline npm installations produce byte-identical dependency trees, the three runtime dependencies execute import probes, and the real marketplace Host entry imports with links to the existing Host settings/schema packages. Local working-tree install checks can still be skipped when their optional development `node_modules` directories are absent; controlled temporary-install verification proves the lock independently. The optional bot's missing Host implementation remains an explicit limitation, not a successful release capability.
