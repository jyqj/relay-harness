# Agent Note: Retrieval-domain search engine — lanes, preselect, RRF, rerank as pure logic

Status: implemented

English | [中文](2026-08-27-code-index-search-engine.zh.md)

## Problem

The `ctx.codeIndex` seam (landed today) defines retrieval vocabulary but owns no ranking mechanics; the SQLite provider and tool consumer cannot share one deterministic ranking without a third package owning formulas once. Spreading constants across provider/consumer would fork behavior per call site — precisely what the reference implementation spent `cc-search` centralizing (lane registry, preselect layers, RRF, rerank table).

## Decision

Land `@relay-harness/rlh-code-index-search` as the retrieval-domain engine over a minimal `RetrievalPort`: numeric constants and formulas are ported verbatim from the reference (`rrf.rs`, `preselect.rs`, `lanes.rs`, `plan.rs`, `fts.rs`, plus the `SearchConfig`/`RankingConfig` default tables), while Rust concurrency collapses into serial execution because registry order is already the deterministic fusion order. Key contract points:

- The grep scan budget splits responsibilities across the port boundary: the store adapter owns row ordering and scope enforcement, the engine owns budget accounting, the two-stage prefilter/full-scan merge, and truncation policy.
- Recoverable store failures degrade into `readErrors` + `degraded` instead of aborting the search; assembly-time registry validation fails loud so broken lane sets never reach a search.
- Per-file preselect bills sum to the file score and the rerank trace total equals the hit score — both asserted against real fixtures, which also stand in for storage-only invariant relationships.

P1 narrows two surfaces on purpose: only `path:` DSL filters parse until symbol data exists, and the `symbol-exact` bonus sits behind an explicit off switch rather than being silently dropped.

## Consequences

Ranking behavior now has exactly one home: changing a constant in `src/config.ts` changes every phase, and new lanes/layers register without touching plan or engine files. Downside inherited from determinism: JS float ordering must keep the reference addition order forever, so refactors inside `rerankCandidate` are behavior-changing even when algebraically equivalent. The scope re-check on decoded grep rows stays redundant with the store-side filter deliberately — drift between concurrent writes and batch fetches must not leak into results.

## Alternatives considered

- **Fold ranking into the SQLite provider** — rejected: the P3 vector lane and any future provider would each need to reimplement fusion/rerank; constants would diverge per backend instead of living in one config table.
- **Keep the Rust thread-group machinery** (`reads_prior_scores` groups) — rejected: with serial execution the grouping is unobservable, so carrying it would be dead scaffolding pretending to preserve parallelism.
