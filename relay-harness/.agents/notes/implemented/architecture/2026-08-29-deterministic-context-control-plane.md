# Agent Note: Deterministic Context Control Plane

Status: implemented

English | [中文](2026-08-29-deterministic-context-control-plane.zh.md)

## Problem

The Context Engine sequenced provider results but did not own eligibility, latency isolation, a shared request budget, duplicate suppression, or the reason a candidate was excluded. Provider-local character limits could not protect the complete model request, and one contributor that ignored cancellation could block every provider after it. AgentLoop durably recorded admitted Evidence but could not explain timeout or budget rejection.

## Decision

`ctx.contextEngine.prepareStep` resolves one deterministic plan before retrieval. Contributor declarations identify supported purposes; the engine assigns every eligible registration a character/token allowance and deadline. Retrieval stays provider-local and sequential, but every call receives a child abort signal. The parent signal aborts the complete preparation, while a contributor timeout aborts only that child and allows later providers to run. A registration generation must still be current when its promise resolves, so disposal or same-id replacement cannot publish a late result.

Providers return whole messages with optional selection metadata. Explicit user references rank before provider-discovered recall for duplicate suppression and total-budget selection. Selected messages return to registration order, preserving stable prompt layout. Providers clip and hydrate under their local allowance; the engine rejects an oversized whole message rather than splitting message, Evidence, and Coverage ownership.

The prepared result carries the immutable plan plus selected and rejected decisions. AgentLoop copies both into `context/prepared`; a rejection-only event records timeout, disposal, duplicate, or budget exclusion without adding model-visible content. When every eligible provider deliberately declines, `prepareStep` still returns `undefined` and leaves the step unchanged.

## Alternatives considered

- **A model retrieval planner** — rejected because eligibility and budget policy must be replayable, low-latency, and independent of another inference call.
- **Centralize provider search and hydration** — rejected because file, code, memory, Session, and MCP sources own different revision and trust semantics.
- **Parallel fan-out immediately** — deferred because deterministic sequential reads plus isolated deadlines close starvation first without introducing shared-provider concurrency races.
- **Slice arbitrary returned messages in the engine** — rejected because generic clipping can invalidate source framing and Evidence locators.
- **Abort the whole request on one timeout** — rejected because one degraded provider must not starve unrelated explicit references.

## Consequences

The default Base composition has explicit total/local budgets and a per-provider timeout. File and MCP Resource references, plus code recall with direct path mentions, carry explicit-reference priority; other recall keeps provider priority. Prompt Enhancement uses the same plan and decision trace as Agent steps. Hydration verification remains provider-owned, and provider calls remain sequential until a separate concurrency design proves ordering, disposal, and backend-capacity behavior.
