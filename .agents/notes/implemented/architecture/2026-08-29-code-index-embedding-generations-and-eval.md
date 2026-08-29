# Agent Note: Govern embedding generations and retrieval evaluation

Status: implemented

English | [中文](2026-08-29-code-index-embedding-generations-and-eval.zh.md)

## Problem

The initial vector tier keyed jobs and vectors by model string, enqueued only chunks belonging to changed files, processed one job per endpoint request and SQLite transaction, and advanced `evidenceEpoch` for vector writes. That made three false assumptions: a model name uniquely identifies an embedding pipeline, unchanged chunks need no reconciliation, and derived vectors are runtime evidence. Enabling embedding after an index existed or switching endpoint/model could leave permanent coverage holes; same-model endpoints could mix incompatible vectors; batching knobs did not affect worker throughput; and the runtime-evidence clock claimed progress when no runtime evidence had been ingested. Retrieval changes also had fixture tests but no reusable Recall@5/MRR corpus runner.

## Decision

Schema v8 adds `embedding_generations`. A generation SHA-256 identity covers provider id, credential-free normalized endpoint identity, model, configured dimensions or explicit `provider-default` mode, normalization version, quantizer version, and chunker version. Jobs and vectors carry `generation_id`; their semantic keys are `(chunk_id, generation_id, content_hash)` and `(chunk_id, generation_id)`. Model remains denormalized for diagnostics and legacy direct-store compatibility, never as the provider's retrieval selector.

On provider open and after every committed refresh, the coverage reconciler computes current chunks minus vectors for the configured generation. It enqueues that set independently of mtimes and prior changed paths. Enabling embeddings, changing endpoint/model/dimensions, or opening an existing store therefore backfills unchanged chunks while older generations coexist until the derived store is rebuilt.

The worker claims a bounded job batch in one lease transaction, batch-reads chunk bodies, embeds all inputs through one client call, quantizes every returned vector, writes the vector rows in one transaction, and settles each job. Aggregate provider usage is distributed deterministically in proportion to estimated input tokens, with the integer remainder assigned in stable order; allocation always sums to provider usage. One successful vector transaction advances `embeddingEpoch` once. `evidenceEpoch` remains a separately seeded, currently unwritten runtime-evidence clock. `indexEpoch` remains the source/index-content clock. Cache keys observe the full returned epoch snapshot.

`evaluateRetrieval()` runs deterministic relevance judgments through only the public `search` seam and reports file-level Recall@5 and MRR with per-case retained rankings. Tests cover a deterministic corpus, the checked-out `code-index-local` package as a real workspace, and a one-file scoped incremental admission. Late refresh scopes are also retained after a pass enters scanning and merged into one detached follow-up generation, closing the watcher-event loss window without breaking pre-scan concurrent folding. Embedding reconciliation likewise retains a post-drain observation bit when a refresh commits during an active worker, closing the final-empty-claim lost-wakeup window; bounded exact vector recall reports scan truncation as degraded partial coverage rather than silently presenting its candidate set as exhaustive.

## Alternatives considered

- **Use `(model, dimensions)` as identity** — rejected because endpoint, normalization, quantizer, and chunker changes can all make vectors incompatible.
- **Backfill only on model switches** — rejected because enabling the tier and repairing missing vector rows are the same set-difference problem.
- **Advance `indexEpoch` for vectors** — rejected because source/index content did not change; a dedicated derived-materialization clock expresses the lifecycle exactly.
- **Continue using `evidenceEpoch`** — rejected because no runtime observation or verified execution evidence is ingested by vector generation.
- **Benchmark private engine methods** — rejected because a green engine benchmark can miss provider mapping, lazy refresh, persistence, and seam output regressions.

## Consequences

Schema mismatch rebuilds the derived store in place, so v6 databases are re-indexed rather than migrated. A configured fixed dimension has exact generation identity. Omitted dimensions use explicit `provider-default` mode and the client locks the first reply for its runtime; deployments requiring cross-restart protection against an endpoint silently changing default dimensionality should configure `dimensions`. Coverage reconciliation is exact for current chunks; a current-content terminal failure receives one durable bounded reset. Scanner/stat/hash/parse stages now use deterministic bounded concurrency and BuildExplain reports the build lifecycle. The eval harness now gates TypeScript/Python/Go fixtures, a real workspace, Recall@5, MRR, and incremental p95. Quantization remains on the Node thread because the measured typical 16x1536 batch costs under 0.5 ms p95 on this machine, below worker handoff cost.
