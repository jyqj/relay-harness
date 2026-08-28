# Agent Note: Graph enrichment and the graph-aware search path

Status: implemented

English | [中文](2026-08-28-code-index-graph-enrich-search.zh.md)

## Problem

The retrieval pipeline stopped at fusion: the graph lane fed RRF rank positions, but no stage turned the stored call graph into per-hit scores or context nodes, the local provider still assembled the plain engine defaults, and the seam `SearchHit` had no field to carry a graph contribution. Production searches ran without any graph rerank even though every ingredient (degrees, adjacency, test edges) was already in the store behind the retrieval port.

## Decision

The reference's graph-aware search path lands verbatim in the graph package's `src/lane/`, and the local provider switches to it.

- **`graphEnrich` ports `cc-search/src/enrich.rs` piece for piece** — batched symbol resolution over the resolve window (`maxResolve` hits, distinct file paths, name equality or span containment, uids deduplicated globally), one degree/ref batch, the score formula `min(ln(in+out+1)/10 + min(refs,10)/100, 0.4)`, and caller/callee/test node collection under the tier's graph token budget. `GRAPH_SCORE_CAP` stays a graph-package constant because the reference keeps the cap as an enrich-side literal; the rerank weight belongs to `RankingConfig` (`graphRerankWeight`, default 0.3), matching the reference's split.
- **Budget breaks clip sections; dedup precedes the budget check.** A break abandons the rest of the caller/callee/test section (the reference's `break`), and a neighbor uid consumed by a clipped iteration stays marked seen — both are load-bearing for exact node-set parity.
- **The port names edge directions by the seed side, the reference by the neighbor side.** Callers of a resolved symbol therefore read through `calleeRowsByUids` (rows where the symbol is the callee); the explain envelope keeps the reference's op vocabulary (`caller_rows_by_uids`) so read-error strings stay comparable.
- **Port-shape compensations, documented at the use sites:** the edge projection carries no stored confidence, so node confidence derives from the resolution kind via the resolver's default-confidence table (`0` when absent); `findImpactedTests` returns raw association rows, so test paths dedupe in-memory where the reference's SQL answered `DISTINCT`.
- **`searchWithGraphContext` is the only place the graph contribution applies** — boost each assigned hit (`score += graphScore · graphRerankWeight`, reason `boost:graph-rerank` appended last), one final sort (score desc, chunkId asc), rank reassignment, then truncation (top-K `undefined` → tier default, `0` → 10). Zero scores assign `graphScore` without boost or reason, mirroring the reference's zero-amount traced boost.
- **The result cache keys both epochs, the request hash (lists order-insensitive), every enrichment limit, the token budget, and the ranking fingerprint** (stable JSON of the resolved `RankingConfig`). The engine's own search config is deliberately absent: a cache instance belongs to one bound engine, and the provider drops the cache whenever a tier resize rebuilds the stack. Degraded outcomes (`readErrors` non-empty) return but never cache, so a transient read failure is retried instead of pinned to the epoch pair. Capacity defaults to 32, the reference's `GRAPH_RESULT_CACHE_CAPACITY` without its env knob.
- **The provider always takes the graph path** — with an empty graph the enrichment resolves nothing and the answer equals the plain pipeline (proven byte-identical by the composed-defaults suite), so no availability probe exists. The seam gained the optional `graphScore` field and the `repoSizeTierTokenBudget` table (4000/6000/8000/12000), and the search tool's strict output schema learned the new optional hit field — the only edit outside the knife's allowed packages, forced by the seam extension this knife owns.

## Alternatives considered

- **Enriching the full rerank window before truncation, like the reference** — rejected for this phase: the harness entry point is the finalized `engine.search(request)`, whose hits are already cut to top-K. The tier tables keep `maxResolve` (3–8) below every tier's top-K (5–20), so the resolution scope is identical; a boost cannot promote a hit that base truncation already dropped, which the provider-level parity suite pins.
- **Exposing the engine's resolved ranking through `createSearchEngine`'s return** — rejected: it widens the search package's face for one caller; `searchWithGraphContext` instead resolves its own `ranking` input verbatim, and the provider passes nothing so defaults match.
- **Marking limit cuts (`maxResolve`/`maxTests`) as truncated** — rejected: the reference's envelope stays empty on ordinary runs that merely hit static limits; only the budget break (a real clip the consumer would otherwise never see) records `output_budget`.

## Consequences

Local answers now rank graph-connected chunks above their base score and report graph-derived degradation through `degraded`/`readErrors`. The enrichment's node views remain an in-package intermediate; projecting them into a model-facing surface is the next phase, which also owns the pending seam gap that `searchWithGraphContext` currently leaves `SearchResult`-shaped (nodes ride beside, not inside, the answer).
