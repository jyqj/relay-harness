# ADR-0001: Simple General-purpose Agent and System Boundary

English | [中文](0001-product-boundary.zh.md)

- **Status:** Partially superseded by 0005 (product boundary remains valid; implementation-language decision does not)
- **Date:** 2026-08-20

## Context

Target users must not need to understand prompt engineering, project structure, concrete models, or internal agent workflows. The product must absorb that complexity while allowing model routing and the agent product to evolve independently.

## Decision

1. Relay is a zero-learning-curve, simple general-purpose agent with Chat and Work.
2. Work is an independent task and does not require creating a Project.
3. This project fully designs the agent side; [ADR-0005](0005-adopt-ts-harness-runtime.md) selects TypeScript Relay Harness as its implementation. The original Rust choice in this item is no longer valid.
4. Relay scheduling is an independent project. This project defines qualitative requirements and a versioned interface, not its internal algorithms.
5. Model routing is infrastructure rather than a product flow users must understand.

## Consequences

- Product documentation describes the user experience before internal modules.
- Files, memory, and Prompt Enhancement must work without a Project prerequisite.
- Scheduling benchmarks, costs, and operating weights do not enter this project's implementation design.
