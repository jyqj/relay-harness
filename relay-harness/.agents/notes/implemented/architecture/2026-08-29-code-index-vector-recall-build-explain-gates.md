# Agent Note: Complete local vector recall and build-quality gates

Status: implemented

English | [中文](2026-08-29-code-index-vector-recall-build-explain-gates.zh.md)

## Problem

Generation-keyed vectors and batching fixed lifecycle correctness, but the vector lane still only re-scored candidates discovered by lexical, grep, graph, or literal lanes. A semantic-only neighbor could not enter fusion. Refresh summaries exposed counts but not why a pass ran or skipped, dirty-closure degradation, backfill work, or completed embedding batches. Scanner, hash, and parser loops were deterministic but serial. The first eval harness had metrics but not a multi-language executable threshold, and terminal embedding failures could remain a permanent coverage hole.

## Decision

`VectorReadFacet.recallCandidates` is the provider-neutral nearest-neighbor seam. The SQLite adapter implements a generation- and scope-filtered exact cosine scan bounded by `vectorMaxCandidates`, returning best-first hits plus scanned/truncated coverage. Future ANN implementations replace this method without changing the lane. The vector lane merges independent recall hits with cosine scores for earlier-lane candidates, deduplicates by maximum similarity, then enters ordinary RRF. Semantic-only hits therefore carry the same `vector@rank` reason and `rrf:vector` score trace as any other vector contribution.

Every refresh now carries `BuildExplain`: full/scoped decision, requested-path count, ran/skipped outcome, degradation reasons, dirty status/marked/rounds/budget state, and generation backfill/reset/batch/job counts. A no-delta refresh opens no write transaction and leaves `indexEpoch` unchanged. Detached embedding completion updates the status-side last refresh and persists its final clocks/counts.

Build I/O uses deterministic bounded concurrency: per-directory stat/symlink work has 16 slots, suspicious hashing has 8, and changed-file reads/parses have 4. `mapConcurrentOrdered` preserves input order regardless of completion order and fails the whole stage loudly. Quantization stays inline: the executable typical-batch guard measures 16 vectors × 1536 dimensions and requires p95 below 25 ms; this machine measured below 0.5 ms, where worker serialization/handoff would increase rather than delete pressure.

The eval gate now covers committed TypeScript, Python, and Go fixture repositories, the checked-out local-index package, deterministic relevance cases, and scoped single-file incremental samples. `assertRetrievalThresholds` fails on Recall@5, MRR, or incremental-p95 regression. Schema v8 adds `reconcile_resets`; current-content terminal failures receive exactly one durable reset, after which another terminal failure remains failed, preventing both permanent first-failure holes and infinite retry loops.

## Alternatives considered

- **Inject semantic hits after RRF** — rejected because they would bypass normal reasons, score trace, rerank, filters, and output budgets.
- **Put exact cosine SQL inside the lane** — rejected because it would bind the domain engine to SQLite and leave no ANN adapter seam.
- **Unbounded `Promise.all` for build stages** — rejected because large repositories would trade latency for descriptor/memory spikes and nondeterministic pressure.
- **Always move quantization to a worker** — rejected by measurement; worker handoff is larger than the current typical batch cost.
- **Reset failed jobs on every reconcile** — rejected because bad credentials would create an infinite retry/spend loop.

## Consequences

Semantic-only recall is now real but exact-scan coverage is intentionally bounded; `VectorRecallResult.truncated` makes that boundary observable to adapters/tests. ANN remains an optimization, not a semantic redesign. BuildExplain is a bounded status/refresh projection and tool output schema, not an unbounded per-file trace. Parallel stages preserve committed ordering and source-hydration semantics. The checked-in multi-language corpus is executable and extensible; adding broad external relevance judgments improves representativeness without changing the gate protocol.
