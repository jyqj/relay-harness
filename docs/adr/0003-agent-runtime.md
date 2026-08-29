# ADR-0003: Agent Loop and Local Verification

English | [中文](0003-agent-runtime.zh.md)

- **Status:** Partially superseded by 0005 (loop and verification semantics remain valid; the Rust implementation decision does not)
- **Date:** 2026-08-20

## Context

Work must continue execution, call tools, handle interruption, and deliver reliably. A successful tool result does not mean the user's goal is complete, but verification must remain independent from model routing.

## Decision

1. The runtime uses the TypeScript Relay Harness selected by [ADR-0005](0005-adopt-ts-harness-runtime.md); the original Rust decision is invalid.
2. CLI, Web, and Desktop reuse the same Relay Harness packages and composition; the original Rust crate plan is invalid.
3. The agent loop is fixed as understand → plan → act → observe → verify locally → continue/deliver.
4. Checkpoints, permission audits, tool results, and verification evidence remain in local run state.
5. Local verification decides only the task outcome; it is not uploaded, used for training, or used for routing.
6. A subagent is a constrained execution unit and must carry a goal, boundaries, acceptance criteria, file references, and routing signal.

## Consequences

- The agent side has no telemetry platform, routing flywheel, or margin dashboard.
- Recovery and verification are runtime requirements, not operating-data capabilities.
- See [`../architecture.md`](../architecture.md) for current module boundaries.
