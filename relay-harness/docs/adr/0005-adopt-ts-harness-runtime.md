# ADR-0005: Adopt the TypeScript Relay Harness Runtime

English | [中文](0005-adopt-ts-harness-runtime.zh.md)

- **Status:** Accepted
- **Date:** 2026-08-23

## Context

ADR-0001 and ADR-0003 selected a Rust agent backend and planned a five-crate workspace including `relay-kernel` (see [`../engineering/tech-stack.md`](../engineering/tech-stack.md)). No implementation existed when that blueprint was written.

The repository instead contains the mature TypeScript Relay Harness monorepo at its root. It provides the agent loop, session persistence and recovery, tools and skills, subagents, permissions and approvals, plan mode, compaction, LSP, sandboxes, CLI/Web/Electron applications, and an established coverage, snapshot, and documentation-gate system. A new Rust implementation would remain behind this verified runtime.

## Decision

1. Relay uses the root TypeScript monorepo, branded Relay Harness (`rlh`), as its agent runtime and does not start a separate Rust kernel implementation.
2. This ADR supersedes ADR-0001 item 3 (“backend uses Rust”) and ADR-0003 items 1–2 (Rust and a reusable kernel library) at the implementation level; their product-boundary and agent-loop semantics remain valid.
3. Responsibilities from the Rust blueprint map to current package groups:
   - `relay-kernel` → `packages/core` (session / system-prompt / tools / agent / agent-loop)
   - `relay-cli` → `apps/cli`
   - `relay-tools` → capability groups such as `packages/fs`, `packages/shell`, `packages/web`, and `packages/skill`
   - `relay-store` → `packages/session` (persistence / projection / checkpoint)
   - `relay-router` → not shipped: the Relay scheduling client remains a product-specific increment above the harness (ADR-0002)
4. OpenAPI + JSON Schema remains authoritative for cross-project interfaces, preserving the conclusion of tech-stack section 1; scheduling remains external.
5. Naming uses the `@relay-harness/rlh-*` npm scope, `rlh` CLI, and `RLH_*` environment prefix. Vendor references for third-party model APIs, including `DEEPSEEK_API_KEY` and `api.deepseek.com`, remain unchanged.

## Consequences

- [`../engineering/tech-stack.md`](../engineering/tech-stack.md) describes the current TypeScript baseline; [`../architecture.md`](../architecture.md) owns implementation architecture.
- Rust-workspace roadmap items are superseded by equivalent harness capabilities. Relay-specific completion claims remain governed by [`../feature-status.json`](../feature-status.json).
- Local verification, externalized state, and explicit file context from ADR-0003 items 3–6 and ADR-0004 remain binding at the plugin layer.
- Telemetry follows ADR-0003's direction: session telemetry is DISABLED by default and has no built-in reporting endpoint; an endpoint can come only from explicit `RLH_TELEMETRY_OTLP_URL` configuration.
