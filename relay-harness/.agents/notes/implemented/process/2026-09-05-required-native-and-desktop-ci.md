# Agent Note: Require native kernels and release-shaped desktop smoke in pull requests

Status: implemented

English | [中文](2026-09-05-required-native-and-desktop-ci.zh.md)

## Problem

Wine and source-level tests do not establish native Windows behavior, real sandbox confinement, or the executable desktop package. Independent jobs outside the required aggregate can fail without blocking a merge. A fresh desktop runner also has no Electron executable merely because the workspace's JavaScript packages and official web/runtime artifacts were built.

## Decision

The [CI aggregate](../../../../../.github/workflows/ci.yml) requires native Windows alongside Wine and calls the reusable [sandbox](../../../../../.github/workflows/sandbox.yml) and [desktop smoke](../../../../../.github/workflows/desktop-smoke.yml) workflows. Its `always()` verdict explicitly rejects failed, cancelled, and skipped dependencies. Called workflows use distinct concurrency prefixes so their cancellation groups cannot cancel their caller. Sandbox proof steps propagate the test process status before inspecting the summary and require both real-kernel files to run; losing the platform probe is not a successful skip.

Desktop smoke runs on hosted macOS and native Windows. It installs the immutable workspace, explicitly runs the pinned Electron package's installer, builds official runtime artifacts, exercises the source application, assembles an unpacked distribution, and exercises that packaged executable. Ordinary workspace installs deny Electron's automatic binary download; the desktop lane owns that cost explicitly. Source and packaged probes assert UI and PTY behavior and reject missing result files or failing exits, rather than checking artifact presence alone. Checkout tokens are not persisted and pnpm action installations use runner-private temporary destinations.

## Alternatives considered

- Keep native and packaged jobs observational: their failure would leave the merge verdict green despite supported-platform regressions.
- Treat a build or unpacked directory as desktop evidence: it does not prove that Electron, the runtime entry, UI boot, and PTY can execute together.
- Enable Electron download for every workspace install: CLI and runtime-only consumers would pay for a GUI binary they do not use; explicit desktop installation preserves the narrower dependency policy.

## Consequences

The [workflow regression tests](../../../../scripts/ci-workflow.spec.ts) pin required dependencies, reusable workflow routing, cancellation separation, failure propagation, and Electron installation before smoke/pack. These tests validate checked-in configuration; actual hosted workflow results remain the authority for platform execution. Pull requests spend additional native-runner time and may wait for that capacity. Real-provider tests remain separately keyed and are not represented as passing by these keyless jobs.
