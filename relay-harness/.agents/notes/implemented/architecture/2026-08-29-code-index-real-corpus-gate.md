# Agent Note: Real-repository Code Index corpus gate

Status: implemented

English | [中文](2026-08-29-code-index-real-corpus-gate.zh.md)

## Problem

The checked-in retrieval fixtures proved algorithms and incremental lifecycle behavior, but they did not establish that the complete scanner/parser/SQLite/search stack could finish a real medium or large checkout. A one-off absolute-path benchmark would not be repeatable after repository flattening, could not run in CI, and would tempt contributors to copy reference repository source into Relay. The product also needed measured facts—full-index time, scoped incremental p95, search p50/p95, file/chunk/parser coverage, and verifiable Recall@K—without upgrading one machine's result into a universal capacity claim.

## Decision

`scripts/code-index-external-corpus.ts` is the executable public-runtime benchmark. It discovers the pnpm workspace by walking from its own module path, resolves corpus roots from an explicit environment variable before cwd/workspace-relative candidates, and never assumes the current nested checkout layout. Corpus definitions and relevance judgments live in `scripts/corpora/code-index-real-repositories.json`; the manifest contains paths and judgments only, never reference source.

The Relay monorepo is a required CI corpus because it is present in every checkout. CodeCortex Rust and the recovered Auggie checkout are optional: an ordinary CI job skips either when absent, while explicitly selecting one or providing its environment root makes absence a failure. `pnpm run eval:code-index:corpus:ci` is therefore deterministic on a clean Relay checkout and extensible on authorized corpus workers.

Each run owns a temporary SQLite database. Full refresh, quality queries, repeated searches, and seven scoped commits all go through `LocalCodeIndexRuntime`. Incremental measurements use one collision-checked temporary source file and remove/reconcile it in `finally`; corpus source is otherwise read-only. The report queries the derived database for file/chunk counts, parser-tier distribution, and files without chunks. Parser exceptions are fatal and atomic in the production pipeline, so a completed run reports `parserErrors: 0` plus `parserFailurePolicy: fatal-atomic`; a parser exception fails the gate instead of becoming an invented per-file counter.

## Measured evidence

On 2026-08-29, the real Relay checkout completed with 8,256 files, 85,472 chunks, and no fatal parser error. Full index observed 120.65 s; seven scoped updates had p95 80 ms; repeated search p50/p95 was 0.051/0.087 ms. Five relevance cases produced Recall@5 0.80 and MRR 0.60. Parser tiers were 4,395 generic, 3,859 semantic, and 2 tree-sitter; one file had no chunks.

The optional authorized CodeCortex Rust checkout completed with 366 files, 5,523 chunks, and no fatal parser error. Full index observed 7.13 s; scoped incremental p95 was 28 ms; search p50/p95 was 0.050/0.080 ms. Five relevance cases produced Recall@5 and MRR of 1.00. Parser tiers were 129 generic, 235 semantic, and 2 tree-sitter; every indexed file had chunks. JSON evidence is committed under `docs/benchmarks/`; no CodeCortex or Auggie source is committed.

## Alternatives considered

- **Copy a reference repository into test fixtures** — rejected because it duplicates source, creates licensing/update risk, and measures a frozen artificial copy rather than an authorized checkout.
- **Hard-code `/Users/...` corpus paths** — rejected because flattening, CI, and other developers would fail before indexing.
- **Make every external corpus mandatory** — rejected because public CI cannot assume private or locally recovered checkouts; explicit selection still makes an optional corpus fail-closed.
- **Mutate and restore an existing corpus file** — rejected because interruption could dirty or corrupt the reference checkout; a unique temporary probe has a bounded cleanup contract.
- **Count generic-tier files as parser errors** — rejected because generic is an intentional fallback for unsupported/oversized inputs. Fatal parser errors abort the atomic pass and fail the runner.

## Consequences

Relay now has repeatable real-repository evidence and an executable CI boundary instead of only a fixture claim. The required Relay gate is expensive compared with unit tests and should run in a dedicated benchmark job, not every fast test shard. Optional corpus results improve representativeness when authorized checkouts are present. Thresholds are intentionally broad cross-machine regression ceilings; the committed measurements remain dated hardware observations, not promises that every repository or machine will match them.
