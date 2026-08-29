# Current Architecture Decisions

English | [中文](README.zh.md)

This directory retains only decisions that independently constrain the current design, not a complete change history.

| Number | Decision | Status |
|---|---|---|
| [0001](0001-product-boundary.md) | Simple general-purpose agent; scheduling is external | Accepted (item 3's Rust implementation superseded by 0005) |
| [0002](0002-routing-and-strength.md) | Pre-request signals drive external routing; strength tiers are user-visible | Accepted |
| [0003](0003-agent-runtime.md) | Agent loop; local verification is independent from routing | Partially superseded (Rust implementation superseded by 0005; loop semantics and verification remain valid) |
| [0004](0004-data-and-action-boundary.md) | Explicit file context, least privilege, and local state | Accepted |
| [0005](0005-adopt-ts-harness-runtime.md) | Root TypeScript Relay Harness as the runtime | Accepted |
| [0006](0006-local-context-engine.md) | Local Context Engine: indexing and retrieval stay local | Accepted |

A new ADR is reserved for a durable cross-module decision with real alternatives. Ordinary feature changes update their authoritative design document directly.
