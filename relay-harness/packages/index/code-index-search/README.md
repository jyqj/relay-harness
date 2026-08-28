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

`createSearchEngine({ port })` returns a synchronous `search(request)` whose stages run in fixed order: plan build runs the preselect fold (`defaultPreselectLayers`: working-set/recent/pinned/overlay rank decay, FTS summaries, per-token symbol/path matching, gated fallback) and normalizes the query, its `path:`/`lang:`/`kind:`/`name:` DSL filters (`parseDslLite`: `lang:` resolves through the stored-language aliases into the scope the store enforces in SQL, where an unknown name filters nothing — exactly like the reference's `Language::from_name`; `kind:`/`name:` act at finalization against the candidate's symbol columns), and top-K by tier; enabled lanes (`createLexicalLane`, `createGrepLane`, a composed graph lane when supplied, and `createLiteralLane` last) execute serially in registry order; fused candidate totals window to the rerank window, batch-fetch details through the port, apply the traced additive table (`overlap·0.35`, doc/prefix/working-set/recent/pinned/overlay bonuses, `min(stage-a·0.04, 0.25)`), and finalize deterministically (DSL kind/name retention, then score desc with chunkId asc ties) under the tier's output-character budget.

Numeric constants and formulas are ported verbatim from the reference implementation's `rrf.rs` / `preselect.rs` / `lanes.rs` / `plan.rs` / `fts.rs`; see `src/config.ts` for the merged default tables. New lanes or preselect layers register via `defineRetrievalLane` / `definePreselectLayer` — assembly validates unique ids and at least one enabled lane at construction time, never mid-search. Recoverable read failures degrade into `readErrors` (+ `degraded=true`) instead of aborting, so callers can route partial results away from caching exactly like the seam contract requires.

## Model Experience

Indirectly, through the search results that `ctx.codeIndex.search()` hands to consumers in rlh-tool-code-index; prompts and schemas remain theirs.

#### KV Cache effect

No direct request-prefix changes; every hit already carries its own `reasons` tokens, so consumers never need to re-explain rankings inside a conversation.

## Known Limitations and Deferred Work

- **The graph retrieval pieces are composed, not built in** — the graph lane and graph-neighbor layer ship from `@relay-harness/rlh-code-index-graph` and join through `defaultRetrievalLanes(graphLane)` / `defaultPreselectLayersForEngine(graphNeighborLayer)`; engines built from the plain defaults stay byte-identical to the pre-graph behavior, and the local provider has not switched to the composed defaults yet.
- **`symbol-exact` rerank bonus is on by default** (`FeatureGates.symbolExactEnabled`): candidate detail rows carry the enclosing symbol name, so the bonus compares real data; adapters that index without symbol names switch the gate off explicitly.
- **`kind:`/`name:` filters act on chunk-level symbol columns only** — a candidate with no stored `symbol_kind` never survives a `kind:` filter, and `name:` retains only candidates whose enclosing symbol name contains the value.
- **The literal lane needs the store's literal mirror** — adapters whose `RetrievalPort` lacks `literalFtsCandidates` keep the lane disabled; the SQLite provider's v3 schema supplies it.
- **No vector lane** — embedding recall joins with the P3 semantic-evidence phase alongside `evidenceEpoch` writers.
