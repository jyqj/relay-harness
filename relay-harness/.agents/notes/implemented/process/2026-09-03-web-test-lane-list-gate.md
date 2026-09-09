# Agent Note: apps/web test lane lists gain an agreement gate and knip covers client tsx

Status: implemented

English | [中文](2026-09-03-web-test-lane-list-gate.zh.md)

## Problem

The apps/web test lane is named by three hand-maintained lists that must stay in lockstep: `tsconfig.host.json` roots the host-plane specs (`apps/web/tests/*.e2e.ts` and friends boot the host spine and read its Context merges, so the client program must not hold them), `apps/web/tsconfig.json` holds exactly those files out of the client program, and `scripts/run-web-snapshots.ts` orders the serial browser owners. Nothing checked their agreement, so a spec could silently escape typecheck: `tests/desktop-chrome.e2e.ts` sat in the client `exclude` but never in the host `include`, and was compiled by no program at all. Separately, `knip.json`'s fallback workspace (`packages/*/*`) named only `.ts` globs, so every client package's `.tsx` sources and `*.spec.tsx` tests were invisible to dead-code analysis.

## Decision

`scripts/web-test-face.spec.ts` parses both tsconfigs through `ts.readConfigFile` (raw globs, not parsed file names) and asserts: the client `exclude` equals the host's `apps/web/tests` include entries except `tests/support.ts`, a shared helper imported by specs on both planes whose imports place it in either program regardless of exclusion; and every entry in all three lists exists on disk. The gate caught one drift, fixed by adding `apps/web/tests/desktop-chrome.e2e.ts` to the host include — that spec is now type-checked for the first time.

`knip.json` gains explicit workspace keys for the 41 packages that own `.tsx` files without one (37 client UI packages, `client/locale`, `extensions/ui-cordis`, `session-query/session-log-export`, `test-support/client-runtime`), each naming `tests/**/*.spec.tsx` (or `spec.ts` for `ui-cordis`, whose client specs are `.ts`) as entry and `src/**/*.{ts,tsx}` / `tests/**/*.{ts,tsx}` as project. `pnpm run knip` stays at zero findings and zero configuration hints.

## Alternatives considered

**Widen the fallback workspace with `.tsx`/e2e/snapshot globs.** Rejected: the knip script runs `--treat-config-hints-as-errors`, and wildcard globs match nothing in most of the ~150 fallback packages, producing 931 configuration hints that fail the hygiene gate. Explicit keys per tsx-owning package match the file's existing style, where every fallback exception already has its own key.

**Leave the lists ungated and rely on review.** Rejected: the lists already drifted in both directions a gate can see (an escaped spec), and each new web test recreates the risk by hand.

## Consequences

A new host-plane web spec dropped from either tsconfig list, a typo in a list entry, or a serial runner file that no longer exists now fails `scripts/web-test-face.spec.ts` instead of escaping typecheck silently. The gate cannot see the third failure shape — a host-plane spec added to neither list roots it in the client program — because the client plane legitimately owns unlisted files (`assembled-boot.ts`, the `.snapshot.ts` specs); that hole stays a review concern. Knip now sees client tsx sources and spec.tsx entries, though its current full-run reporting surfaces unused files only for the root workspace: client packages' `src/**` enters the module graph as workspace-dependency entry surface, so entry-level files cannot be reported unused. Widened coverage therefore reports zero new findings today while closing the configuration gap for future knip behavior.

## Related

- [uniform Agent Note format](2026-07-05-uniform-agent-note-format.md)
