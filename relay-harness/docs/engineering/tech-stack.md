# TypeScript Engineering Baseline

English | [中文](tech-stack.zh.md)

> [ADR-0005](../adr/0005-adopt-ts-harness-runtime.md) selects the TypeScript Relay Harness monorepo under the `relay-harness/` runtime root. [`../architecture.md`](../architecture.md) owns detailed runtime architecture; this page summarizes technology choices and dependency direction.

## 1. Confirmed baseline

- Runtime packages and applications use TypeScript and ESM on supported Node.js versions.
- Relay scheduling is an external project; this repository owns only its future interface client.
- CLI, Web, Desktop, and SDK projections reuse the same plugin runtime rather than copying agent-loop logic.
- OpenAPI + JSON Schema remains authoritative for cross-project interfaces rather than internal TypeScript types.
- Cordis composition and package manifests define runtime assembly.

## 2. Monorepo layout

```text
packages/    Cordis plugins grouped by domain and capability role
apps/        CLI, Web, and Electron Desktop product applications
python/      Python SDK and bundled runtime distribution
native/      Platform-native helpers and packages
examples/    Runnable compositions and integration examples
docs/        Product, architecture, subsystem, and generated references
scripts/     Repository gates, generators, and release tooling
```

## 3. Module rules

- Core runtime packages do not depend on product UI implementations.
- Tools, storage, scheduling, memory, and context capabilities integrate through owned Cordis services and plugins.
- Process, network, persistence, and wire errors become stable domain diagnostics at their owning adapters.
- Local verification belongs to the agent loop, not the future scheduling client.
- File access passes through explicit workspace/file context and permission policy.

## 4. Component direction

| Component | Direction | Status |
|---|---|---|
| Runtime | TypeScript + Node.js ESM | Current |
| Composition | Cordis plugin graph | Current |
| Persistence | Local session/storage providers, including SQLite where owned | Current |
| Product applications | CLI + React Web + Electron Desktop | Current |
| Package manager/build | pnpm workspaces + TypeScript project references + tsdown/Vite | Current |
| Testing | Vitest, Playwright, snapshots, contract fixtures | Current |
| Cross-project protocol | OpenAPI + JSON Schema + HTTP/JSON/SSE | Scheduling client planned |
| Native isolation | Platform helpers under `native/` and sandbox packages | Current |

## 5. Explicit exclusions

- This repository does not implement the scheduling model pool, benchmark weighting, cost weighting, or routing algorithm.
- The agent side does not build a training-data pipeline or margin dashboard.
- CLI constraints do not limit the ordinary-user product experience.
- Distributed state, message queues, and microservice decomposition are not default runtime prerequisites.
