# Current Engineering Baseline and Acceptance

English | [中文](p0-scope.zh.md)

## Status

[ADR-0005](../adr/0005-adopt-ts-harness-runtime.md) selects the root TypeScript monorepo as the current implementation. This document describes current engineering acceptance rather than planning a Rust workspace.

[`../feature-status.json`](../feature-status.json) is authoritative for feature completion. A feature may be `shipped` only when default composition, Remote/API, UI, e2e, and documentation evidence all exist.

## Shipped baseline

- Agent loop, session log, recovery, checkpoints, and subagents;
- shared runtime and composition across CLI, Web, and Desktop;
- ordinary-user-safe `workspace-write + ask` defaults;
- Chat/Work/Library product shell and explicit Prompt Enhancement;
- local Context Engine, Memory, and Code Index;
- MCP tools/resources/prompts and skill inventory/import.

## Current engineering gates

1. Root `.github/workflows/` is the only GitHub automation entry and workflows operate on the root monorepo.
2. `scripts/verify-feature-status.mjs` validates feature claims and default-composition closure.
3. Typecheck, focused tests, Web snapshots, `doc-sync`, and release rehearsal each prove their own boundary; a narrow pass is never described as repository-wide green.
4. Generated config, persistence, tool, Cordis, and capability catalogs stay fresh with source.
5. The unimplemented external scheduling client and model-strength UI remain `planned` and do not enter shipped prose.

## Next acceptance targets

- External scheduling HTTP/JSON + SSE client and contract fixtures;
- user-visible model-strength and pricing disclosure;
- remote GitHub workflow discovery and required-check ruleset verification after the root-governance commit is pushed.
