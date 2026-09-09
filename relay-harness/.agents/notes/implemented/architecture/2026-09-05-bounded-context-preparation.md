# Agent Note: Bounded context preparation

Status: implemented

English | [中文](2026-09-05-bounded-context-preparation.zh.md)

## Problem

Independent per-provider timeouts do not bound the latency of an entire preparation. Sequential providers accumulate delays, while unavailable retrieval collapsed into an absent contribution and hid degradation from the accepted step's durable trace.

## Decision

[ContextEngine](../../../../packages/context/context-engine/README.md) owns one preparation deadline, a configurable provider concurrency cap, and a child cancellation signal for each registration generation. Queue time consumes the complete allowance. Parent cancellation and engine unload fail the preparation atomically; individual disposal or timeout releases the logical slot and ignores late fulfillment or rejection. Results detach at provider completion and pack by explicit-reference priority and registration order, never completion order.

[Code Context](../../../../packages/context/code-context/README.md) reports unavailable retrieval through classified `ContextProviderError` outcomes. The engine records only stable declined, degraded, or error reason tokens; unknown provider exceptions become `error/provider_failed`. Raw queries and exception messages do not enter diagnostics. Malformed contributions and internal `ContextEngineError` remain fatal. Missing required `fs` for explicit file context or `codeIndex` for code context throws `CONTEXT_ENGINE_INVALID_CONTRIBUTOR`; deployment errors are not degraded into absent retrieval results. An ordinary absent contribution remains a silent decline, while explicit classified declines retain their trace.

## Alternatives considered

- **Only shorten local timeouts** — latency still grows with provider count and queued providers lack a shared allowance.
- **Unbounded parallel retrieval** — a large registry can overload providers and consume resources beyond the caller's needs.
- **Turn degraded retrieval into no-results text** — unavailable evidence cannot establish a negative finding.

## Consequences

Preparation latency is bounded for asynchronous provider work, and healthy providers can complete without waiting for every slow peer. The engine cannot preempt synchronous JavaScript or stop an uncooperative provider's underlying I/O; it aborts signals and rejects late results. Rejection-only traces add durable metadata without model tokens. Loader and AgentLoop acceptance tests pin degraded and failed search traces against unchanged model input; focused tests pin queue expiry, cancellation, disposal, stable packing, and late-result isolation.
