# @relay-harness/rlh-code-index-search

English | [中文](README.zh.md)

The retrieval-domain engine behind `ctx.codeIndex.search()`: deterministic file preselection, lexical/grep/literal retrieval lanes, RRF fusion, and the additive rerank table — as pure logic over a [`RetrievalPort`](src/port.ts). The package owns HOW candidates are ranked; the SQLite store owns row ordering, scope enforcement, and decode budgets through its adapter, and no module here touches fs, SQL, or clocks. The port also declares a `graph` read facet (`GraphReadFacet`: symbol seeds, call-edge rows, degrees, chunk spans, imports, complete per-file edge reloads, importer reverse lookup, resolved re-export targets, impacted tests, export fingerprints, literals) that store adapters implement today. The graph lane and graph-neighbor preselect layer that read that facet live in `@relay-harness/rlh-code-index-graph` (`createGraphLane` / `createGraphNeighborLayer`), which depends on this package; they compose into the engine through the extension slots of `defaultRetrievalLanes` / `defaultPreselectLayersForEngine`, so this side cannot hard-register them without the forbidden dependency cycle. The literal lane reads the optional `RetrievalPort.literalFtsCandidates` mirror (classified `literal_index` rows); ports without it keep the lane disabled, so pre-literal adapters stay valid.

This package is part of the code-index capability:

| Package | Role |
|---|---|
| `@relay-harness/rlh-code-index` | Service Definition: abstract service, vocabulary types, repository-size tiers |
| `@relay-harness/rlh-code-index-search` (this) | Retrieval domain engine: lanes, preselect layers, RRF fusion, rerank/finalize |
| `@relay-harness/rlh-code-index-sqlite` | Service Provider: workspace scan, incremental diff, SQLite-backed index implementing the port |
| `@relay-harness/rlh-tool-code-index` | Consumer: model-facing search/status/refresh tools |

## Pipeline

`createSearchEngine({ port })` returns a synchronous `search(request)` whose stages run in fixed order. Plan build augments the primary text with at most four newest distinct `conversationQueries`, folds preselection (working-set/recent/pinned/overlay rank decay, FTS summaries, token symbol/path matching, gated fallback), normalizes the `path:`/`lang:`/`kind:`/`name:` DSL and tier top-K, then runs enabled lanes serially. Fused candidates batch-fetch detail rows carrying file content hash, language, and actual parser tier/confidence; rerank emits the complete ordered additive `scoreTrace` (`overlap·0.35`, doc/prefix/working-set/recent/pinned/overlay bonuses, `min(stage-a·0.04, 0.25)`), and finalization applies DSL retention then score-desc/chunkId-asc ordering under the tier output budget. Chunk source text feeds scoring inside the port but stays out of `SearchHit`; the seam's separate hydration operation owns source delivery.

Numeric constants and formulas are ported verbatim from the reference implementation's `rrf.rs` / `preselect.rs` / `lanes.rs` / `plan.rs` / `fts.rs`; see `src/config.ts` for the merged default tables. New lanes or preselect layers register via `defineRetrievalLane` / `definePreselectLayer` — assembly validates unique ids and at least one enabled lane at construction time, never mid-search. Recoverable read failures degrade into `readErrors` (+ `degraded=true`) instead of aborting, so callers can route partial results away from caching exactly like the seam contract requires.

## Model Experience

Indirectly, through the search results that `ctx.codeIndex.search()` hands to consumers in rlh-tool-code-index; prompts and schemas remain theirs.

#### KV Cache effect

No direct request-prefix changes; every hit carries `reasons` plus its numeric `scoreTrace`, so consumers can explain ranking without reconstructing engine state.

## Known Limitations and Deferred Work

- **Graph retrieval remains composition-owned** — plain engines stay graph-free; the local provider explicitly composes the graph lane and graph-neighbor layer from `@relay-harness/rlh-code-index-graph`.
- **`symbol-exact` rerank bonus is on by default** (`FeatureGates.symbolExactEnabled`): candidate detail rows carry the enclosing symbol name, so the bonus compares real data; adapters that index without symbol names switch the gate off explicitly.
- **`kind:`/`name:` filters act on chunk-level symbol columns only** — a candidate with no stored `symbol_kind` never survives a `kind:` filter, and `name:` retains only candidates whose enclosing symbol name contains the value.
- **The literal lane needs the store's literal mirror** — adapters whose `RetrievalPort` lacks `literalFtsCandidates` keep the lane disabled; the SQLite provider's v8 schema supplies it.
- **Vector recall is a bounded exact scan today** — the vector adapter independently returns generation-scoped semantic candidates under `vectorMaxCandidates`, then the lane merges them with cosine reranking of earlier-lane candidates and feeds normal RRF/reasons/score trace. When the scan hits its bound, the lane records partial semantic coverage in `readErrors` and marks the complete answer `degraded=true`, so consumers never cache or inject it as exhaustive recall. `VectorReadFacet.recallCandidates` is the replacement seam for a future ANN adapter.
