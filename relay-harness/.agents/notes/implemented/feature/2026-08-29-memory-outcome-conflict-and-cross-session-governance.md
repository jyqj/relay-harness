# Agent Note: Cross-session Memory governance and outcome ranking

Status: implemented

English | [中文](2026-08-29-memory-outcome-conflict-and-cross-session-governance.zh.md)

## Problem

The first Memory Center bounded why-used to one attached Session, exposed no canonical signals or outcomes, and compared only explicit supersession links. SQLite still called every retrieval hit “useful” in legacy accounting even though no result evidence supported that interpretation. Historical message feedback and Work completion could not influence recall ranking.

## Decision

Memory Center now scans the complete same-workspace live-preferred Session Query corpus with bounded concurrency. `readSession()` validates persisted history without creating or resuming an Agent. Only admitted `context/prepared` contributions count as why-used, and coverage reports complete, partial, or unavailable with scanned/failed counts.

The canonical seam exposes signal history, deterministic conflict lookup, atomic per-Session outcome reconciliation, and outcome reads. SQLite version 4 persists outcome observations and uses only positive/negative impact for a bounded ±0.1 search adjustment. Turn completion/failure, injection, candidate hits, and blocked Work remain neutral or legacy accounting; they never boost ranking merely because retrieval occurred. Governance revisions atomically append `user_confirmed` or `user_rejected` signals tied to the exact durable governance event.

Candidate review always runs canonical kind plus normalized-content/summary detection first. An optional `memoryConflictDetector` seam may add provider-attributed `semantic-conflict` candidates; Memory Center validates Scope and attribution and presents reasons/score/detector rather than asserting inferred contradiction as fact.

`memory-outcome-reconciler` performs a background persisted scan and reacts to live relevant Session events plus Host-local `message-feedback/changed`. It replaces each Session's derived outcome set, so rating changes/deletion retract old observations. A failed feedback read aborts replacement and preserves the last durable set, while a failed full scan clears its memoized attempt so later inspection can retry. Explicit positive/negative Assistant ratings affect ranking; durable Goal completion is positive; ordinary turns and Goal block are neutral. Memory Center projects signals, cross-session usage, conflict candidates, outcome history, and the exact ranking adjustment.

## Alternatives considered

- **Increment usefulness on every recall** — rejected because admission and successful completion do not prove relevance.
- **Infer sentiment from free-text `/feedback`** — rejected because deterministic governance must not guess polarity.
- **Resume Sessions to inspect history** — rejected because a management read must not acquire Agent ownership or produce effects.
- **Block approval on semantic candidates** — rejected because optional detectors provide review evidence, not authority over the user's decision.

## Consequences

The prior explicit Memory product gaps are closed without inventing retention or causal certainty. Cross-session aggregation is complete-or-labeled-partial, review signals are canonical, feedback deletion is retractable, and ranking uses only explicit outcome impact. Deployments may add a richer conflict detector, while the shipped deterministic path stays local and reproducible.

