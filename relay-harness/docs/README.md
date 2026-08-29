# Relay Documentation Map

English | [中文](README.zh.md)

This directory describes Relay's **current design** rather than retaining a complete change history. Each concept has one authoritative home; other documents link to it instead of maintaining duplicate rules.

## Reading order

1. [`CONTEXT.md`](CONTEXT.md) — product definition, system boundaries, and terminology
2. [`product/vision-and-positioning.md`](product/vision-and-positioning.md) — positioning, target users, and value proposition
3. [`product/product-experience.md`](product/product-experience.md) — simple experience, Chat/Work, and Prompt Enhancement
4. [`feature-status.json`](feature-status.json) — current feature status and verifiable evidence
5. [`repository-governance.md`](repository-governance.md) — GitHub workflow authority, branch protection, and the outer-container/runtime-root split
6. [`agent/overview.md`](agent/overview.md) — overall TypeScript Relay Harness architecture
7. [`agent/agent-runtime.md`](agent/agent-runtime.md) — agent loop, state, recovery, and local verification
8. [`agent/work-and-files.md`](agent/work-and-files.md) — project-free Work and file context
9. [`agent/memory.md`](agent/memory.md) — implemented memory governance and product boundaries
10. [`agent/context-engine.md`](agent/context-engine.md) — local Context Engine, multi-source retrieval, Evidence, and packing
11. [`scheduling/interface.md`](scheduling/interface.md) — unshipped external scheduling interface

## Directory responsibilities

| Directory | Authoritative content |
|---|---|
| `adr/` | The small set of architecture decisions that still constrain the current design |
| `product/` | Product positioning, experience, pricing direction, roadmap, and risks |
| `agent/` | Agent-side modules, contracts, and runtime design |
| `scheduling/` | Qualitative requirements, boundaries, and interface for the external scheduling project |
| `engineering/` | Current TypeScript implementation baseline and engineering acceptance criteria |

## Authority boundaries

- This directory owns product semantics, system boundaries, ADRs, and machine-readable feature status.
- [`architecture.md`](architecture.md) and the subsystem directory own current package, protocol, event, and configuration contracts.
- `.github/` exists only at the repository root; a nested `.github/` is rejected by the governance verifier.
- A feature is not inferred to be shipped from a roadmap or README; read only [`feature-status.json`](feature-status.json).

## Document inventory

### product/

- [`vision-and-positioning.md`](product/vision-and-positioning.md)
- [`product-experience.md`](product/product-experience.md)
- [`pricing-and-tiers.md`](product/pricing-and-tiers.md)
- [`roadmap.md`](product/roadmap.md)
- [`risk-register.md`](product/risk-register.md)

### agent/

- [`overview.md`](agent/overview.md)
- [`agent-runtime.md`](agent/agent-runtime.md)
- [`prompt-enhancing.md`](agent/prompt-enhancing.md)
- [`prompt-enhancing-context-pipeline.md`](agent/prompt-enhancing-context-pipeline.md)
- [`work-and-files.md`](agent/work-and-files.md)
- [`memory.md`](agent/memory.md)
- [`context-engine.md`](agent/context-engine.md)
- [`routing-signals.md`](agent/routing-signals.md)
- [`orchestration.md`](agent/orchestration.md)
- [`verification-and-effects.md`](agent/verification-and-effects.md)
- [`security-and-data-boundary.md`](agent/security-and-data-boundary.md)
- [`tools-and-skills.md`](agent/tools-and-skills.md)

### scheduling/

- [`overview.md`](scheduling/overview.md) — what external scheduling must provide, without specifying its algorithms
- [`interface.md`](scheduling/interface.md) — HTTP/JSON + SSE contract

### engineering/

- [`tech-stack.md`](engineering/tech-stack.md)
- [`p0-scope.md`](engineering/p0-scope.md)

## Maintenance rules

1. **Current state first:** remove migration narration such as “previously,” “used to,” or “retired.”
2. **One authoritative home:** product experience, runtime, memory, and scheduling interfaces each belong to their dedicated document.
3. **Separate facts from proposals:** mark unresolved decisions as `[Decision pending]` and experimental parameters as `[Calibration pending]`.
4. **Scheduling boundary:** this project defines scheduling requirements and interfaces, not internal scheduling algorithms.
5. **Decision discipline:** only cross-module, durable decisions with real alternatives belong in ADRs.
