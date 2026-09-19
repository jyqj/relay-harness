# Agent Note: The legacy-API exit guard reads source text against one allowlist

Status: implemented

English | [中文](2026-09-20-legacy-api-exit-guard.zh.md)

## Problem

[ADR-0007](../../../../docs/adr/0007-legacy-api-exit-conditions.md) records which business domains still answer on both client-facing surfaces, but a prose table cannot stop a new API-proxy handler or a forgotten retirement; unmanaged duplication grows exactly where nobody is looking.

## Decision

`scripts/legacy-api-exit.ts` extracts three facts as plain text and compares them: the `/remote` default imports of the api-remotes client assembly, the `RpcMethodMap` keys of the API proxy, and the `PRIVILEGED_METHODS` set literal in the connection package. The assertions are: the computed duplicated-domain set equals `DUPLICATED_DOMAIN_ALLOWLIST`, every mounted remote contribution appears in `REMOTE_WIRE_TABLE`, and the fence list equals the pinned `EXPECTED_PRIVILEGED_METHODS`. `scripts/legacy-api-exit.spec.ts` runs the live tree through `collectExitViolations` inside `pnpm run test` (the `scripts/ci-workflow.spec.ts` precedent) and proves each failure direction with synthetic inputs: an unallowlisted duplication, a stale allowlist entry whose surfaces are gone, fence drift in both directions, and extractors that ignore comments and type-only re-exports.

## Alternatives considered

- **Parse with the TypeScript compiler.** The three anchors (default import lines, quoted map keys, one `Set` literal) are stable, and the negative tests pin the extractors; a compiler pipeline would add a dependency to buy nothing.
- **A prose gate under `doc-sync`.** A documentation check cannot compare three source files against each other or run at `pnpm run test` speed.
- **Pin only the fence list.** The fence list alone would still let a third surface appear unrecorded; the allowlist comparison is what turns ADR-0007's table into an executed invariant.

## Consequences

- Migrating a domain means deleting its losing surface and dropping its allowlist entry in one change; a stale entry fails `pnpm run test`.
- A new API-proxy handler over a tabled remote domain, or a remote contribution missing from the table, fails until the decision is recorded.
- Renaming or restructuring any of the three anchored files requires updating the script's paths or extractors in the same change.
- The extractors read text, so a formatting change that breaks an anchor surfaces as a guard failure naming the drifted file, not as silent acceptance.
