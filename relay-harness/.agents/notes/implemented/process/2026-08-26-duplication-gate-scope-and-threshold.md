# Agent Note: Duplication gate scope and threshold

Status: implemented

English | [中文](2026-08-26-duplication-gate-scope-and-threshold.zh.md)

## Problem

The `duplication` gate had two defects. Its scope was `jscpd --config .jscpd.json packages scripts` with `format: ["typescript", "tsx"]`, so the repository's 181 JavaScript files — `apps/desktop`'s 35k-line main process included — sat entirely outside clone detection. And the config carried `"exitCode": 1`, which in jscpd 5 means "exit nonzero when any clone is found"; with 33 clones already present on `packages`+`scripts`, `pnpm run duplication` exited 1 on an untouched tree. No CI run has ever completed on this repository (the single run was cancelled), so the always-red gate was never observed.

## Decision

The gate scans `packages scripts apps` with `format: ["typescript", "tsx", "javascript"]` and `pattern: "**/*.{ts,tsx,js,jsx}"`, ignores `apps/desktop/vendor/**` (prebuilt third-party drops, not owned source), and replaces `exitCode` with `"threshold": 1`: the gate exits nonzero only when duplicated lines exceed 1% of scanned lines. Current state is 0.49% total (150 clones; JavaScript alone is 3.28%/117 clones concentrated in `apps/desktop`, TypeScript 0.11%), so the gate is green with roughly 2× headroom and turns red on sustained duplication growth. The per-format table keeps the desktop JavaScript cluster visible on every run.

## Alternatives considered

**Keep `exitCode: 1` and deduplicate all 150 clones first.** The desktop JS dedup is a multi-week migration; an always-red gate gives no signal in the meantime. Lost to the threshold, which restores a usable boundary now.

**Exclude `apps` until desktop is migrated.** That re-creates the blind spot this change removes. Lost to including apps with the vendor drop ignored.

## Consequences

Clone detection now covers the untyped JavaScript world that hosts `apps/desktop`'s git subsystem, so future parallel implementations there surface as gate pressure instead of accumulating invisibly; the measured 3.28% JavaScript duplication is the quantified backlog for the eventual desktop extraction. The 1% threshold is a ratchet, not a ceiling: once desktop dedup lands, lowering it toward the TypeScript baseline (0.11%) is the follow-up. Until then, duplication can grow within the envelope without the gate noticing — that is the accepted cost of restoring signal.

## Testing

`pnpm run duplication` exits 0 at the current 0.49%; `npx jscpd --config .jscpd.json --threshold 0.1 packages` exits 1, proving the breach condition fires.
