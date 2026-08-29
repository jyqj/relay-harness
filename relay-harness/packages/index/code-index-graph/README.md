# @relay-harness/rlh-code-index-graph

English | [中文](README.zh.md)

Symbol-resolution layer for the Relay Harness code-index capability: an in-memory symbol catalog plus the nine-step resolution ladder that binds unresolved call edges and symbol refs to target symbols, ported from the reference implementation's `cc-index` resolver with confidence tables, penalties, and DB mapping preserved exactly. The `dirty/` modules carry the incremental dirty-propagation phase: export-surface fingerprinting, the fixpoint import closure, the dirty-reload policy, and the promotion orchestration.

This package is part of the code-index capability:

| Package | Role |
|---|---|
| `@relay-harness/rlh-code-index` | Service Definition: abstract service, vocabulary types, repository-size tiers |
| `@relay-harness/rlh-code-index-parser` | Parsing layer: grammar loading, per-file extraction records, chunking |
| `@relay-harness/rlh-code-index-graph` (this) | Resolution layer: symbol catalog, nine-step ladder, type-catalog second pass, dirty propagation |
| `@relay-harness/rlh-code-index-sqlite` | Storage repository: schema, epoch-bumped writes, retrieval port adapter |
| `@relay-harness/rlh-code-index-search` | Retrieval domain engine: preselection, lanes, fusion, rerank |
| `@relay-harness/rlh-code-index-local` | Service Provider: scan/diff/chunk pipeline wired behind `ctx.codeIndex` |
| `@relay-harness/rlh-tool-code-index` | Consumer: model-facing search/status/refresh tools |

## Symbol catalog

`SymbolCatalog` registers symbol rows into seven lookup surfaces — lowercased leaf name, uid, qualified name, qualified-name leaf segment, file, nested per-file name/qname, and per-file exports — and answers the lookups the ladder and fallback need: same-file name/qname probes, export resolution, owner-class walks, member chains through five layers, and the `find_best` fallback (unique qname, then same-file, then import-distance, capped by `maxFuzzyPool`, default 256). `removeFiles` prunes every surface, mirrors removals into the embedded type catalog, and tombstones slots without reusing them, so indices captured earlier — including memoized results — stay valid. `CatalogSliceCache` expresses the reference's cross-build catalog reuse as explicit per-file operations (`addFile` / `removeFile` / `invalidateFile`); the resolve memo is an LRU keyed by the full query tuple whose line component participates only when scopes exist, mirroring the reference's key guard.

## Resolution ladder

`resolveName` walks the ladder in a locked order — self-member, scope binding, same-file, import, suffix, global-unique, fuzzy arg-count, fuzzy receiver, fuzzy import distance. The self-member step is authoritative: a `this.`/`self.`-prefixed name that misses on the owner class aborts the whole ladder instead of reaching an unrelated global. The fuzzy steps share one by-name candidate pool seeded at global-unique; the signal steps narrow it (arity evidence with defaulted-parameter and metadata-less-wildcard tiers, then receiver-type tri-state compatibility), and the import-distance step tie-breaks the survivors. Confidences are exact: kind bases from 1.0 (exact) down to 0.30 (fuzzy-multi), a candidate-count penalty exempting pools of three and below, a 0.6× penalty on an import-unreachable global-unique winner, and 0.5× penalties on signal-narrowed and fully-unreachable fuzzy wins.

## Entry API and purity

`createSymbolResolver({ catalog, loadSymbolsForFiles? })` returns a resolver whose `resolveEdges` is a pure rows-in/rows-out pass: it backfills empty strategy/confidence defaults, never overwrites rows that already carry a target, resolves through the ladder when imports or scopes give rich context (falling back to `find_best` with `same_file_fallback`/`global_fallback` provenance), records direct dispatch plus the five-branch call classification on ladder hits, and reports per-kind bind counts. Untouched rows keep their object identity; rewritten rows are new objects. The stored vocabulary is preserved on output: `import_resolved` folds to `scope_resolved`, every fuzzy/name-evidence kind folds to `heuristic`, and signal-narrowed wins write the `fuzzy_arg_count`/`fuzzy_receiver` strategy overrides.

## Type-catalog second pass

After the main pass, every call edge is re-adjudicated under a gate: exact/qualified/scope-proven results are never touched, unresolved and generic-heuristic results are overwritten unconditionally, and name-evidence-only results (`global_unique`, `suffix`, `fuzzy_*`) may be replaced by a strictly better proposal at higher confidence for a different target, recording `"{strategy}:upgraded_from={old}"`. Proposals come from the embedded type catalog in fixed precedence — type-assign-inferred receiver (0.90), raw receiver type (0.95), then unique arg-count match (0.9).

## Dirty propagation

`computeExportFingerprint` hashes a file's exported symbols (`uid|name|signature|exportName` lines, whole-line sorted, SHA-256; `null` with no exports) so an incremental build seeds its closure only from files whose public surface actually moved. `computeDirtyClosure` expands that seed set as a fixpoint: each round finds the seed files' importers through an injected lookup, promotes the promotable ones in sorted order, and re-checks every promoted file's effective surface (its resolved re-export targets, via `reexportTargetsChanged`) inside an inner fixpoint so same-round sibling chains still reach their own importers. The promotion budget is global across rounds and strictly-greater-than: round-1 overflow keeps a budget-sized deterministic prefix and reports `budget_exceeded`; later-round overflow keeps the completed-round boundary and reports `partial_closure`; a 16-round hard cap bounds pathological chains. The outcome classifies as `normal` / `partial_closure` / `budget_exceeded` / `disabled` for the pass report.

`runDirtyPropagation` orchestrates the phase over a committed store: it compares the pre-write fingerprints (caller-captured) against the post-write ledger, seeds removed/renamed paths alongside the export-changed files, promotes through the closure, syncs the resolver catalog for the promoted files, and re-resolves their stored edges in place — the `dirty-reload policy` table declares each edge category's fate (`symbols`/`imports` keep, `callEdges`/`symbolRefs` clear), the exhaustive switch is the compile-time constraint, and `reloadEdgesForFiles` reads the stored rows back through the store's graph facet for `reresolveDirtyFiles`.

## Graph retrieval lane

`src/lane/` carries the retrieval-side graph consumers, ported from the reference implementation's `cc-search` graph pieces. `createGraphLane` seeds symbols from the query's first five tokens (sub-3-character tokens resolve through exact-name equality on both common casings, longer tokens through the substring seed lookup with exact matches scored 1.0 and partial hits 0.5; scores merge by maximum and the field cuts to 20 seeds), expands one hop of call edges in both directions at `seed × 0.5`, maps every neighbor uid back to its smallest containing chunk, and cuts to the plan's graph limit. It is fusion-only by design: it feeds RRF rank positions but annotates no hits, emits no reasons, and keeps its chunk scores lane-local. `createGraphNeighborLayer` (layer 8, after the built-in fallback) expands preselect candidates with 1-hop call-graph neighbor files of the top-20 scored files — absent files enter at 0.8, each further edge sighting adds 0.1 capped at 1.2, and the field cuts to the remaining preselect budget with the `graph-neighbor` reason. Both read the graph face of the search package's `RetrievalPort` and fail best-effort: a rejected edge read removes only its own contribution, and a lane seed/chunk-mapping failure degrades into `readErrors` through the engine's lane guard. Composed engine defaults ship as `defaultRetrievalLanesWithGraph()` / `defaultPreselectLayersWithGraphNeighbor()`; the registration order (lexical → grep → graph, graph-neighbor after fallback) stays owned by the search package because the workspace dependency direction forbids the reverse import.

`graphEnrich` and `searchWithGraphContext` complete the reference's graph-aware search path. `graphEnrich` resolves the finalized hits to symbol uids (name equality or span containment, uids deduplicated globally), scores each resolved chunk `min(ln(in+out+1)/10 + min(refs,10)/100, 0.4)`, and collects caller/callee/test context nodes under the tier's graph token budget — budget breaks clip the rest of a section rather than skipping single entries, and every failed store read degrades into the `GraphExplainCollector` envelope (`"{op}: {error}"` entries capped at 8 with a dropped count, stable truncation tokens such as `output_budget`). `searchWithGraphContext` folds the score into each hit through `RankingConfig.graphRerankWeight` (default 0.3, reason `boost:graph-rerank`), runs the single final sort (score desc, chunkId asc) with rank reassignment, truncates to the request top-K (`undefined` → tier default, `0` → 10), and caches the outcome in an LRU keyed by both epochs, the request hash, every enrichment limit, the token budget, and the ranking fingerprint — degraded results (`readErrors` non-empty) are returned but never cached. Enrichment node views are this package's intermediate form; the consumer-facing projection is a later phase.

## Model Experience

### Resolved graph rows

#### What the model sees

Nothing. The resolver is a library layer that binds stored rows to target symbols; its `resolution_*` fields reach a model only when a Consumer package (the code-index tools and their graph surfaces) renders them through a documented surface of its own.

#### Token effect

Zero. No text from this package enters any model request; resolution only enriches rows the index already stores.

#### KV Cache effect

Independent: resolution runs inside index refresh passes and never touches request prefixes, so nothing here can invalidate provider cache reuse.

## Known Limitations and Deferred Work

- **Store orchestration is in place; the lane is wired through the provider** — `store/` maps parse outcomes onto the storage write face (`buildGraphDelta`, `graphRowsForOutcome`), decides and dispatches the test-edge rebuilds (`decideTestEdgeRebuild` / `applyTestEdgeRebuild`), and runs the dirty-reresolve pass (clear resolved targets, re-resolve, `writeResolvedEdges`); the dirty-propagation phase runs inside the local provider's incremental passes, not standalone.
- **The lane and enrich path are wired; node projection is not** — the local provider runs the composed defaults and `searchWithGraphContext` on every search (empty graph degenerates to the plain result), and the seam `SearchHit` carries `graphScore`; the enrichment's context nodes stay an intermediate view until a consumer phase projects them into a model-facing surface.
- **Scopes are a dormant interface** — no parser emits lexical scopes yet, so the scope-binding step and the scope-proximity ranking stay inert (`request.scopes` is normally empty); the interface is kept for reference parity.
- **No cross-build catalog parking** — the reference persists a whole built catalog behind a validated seed token; this package keeps only the explicit per-file slice cache, so a cold start rebuilds the catalog from the store.
- **No semantic edges or route resolution** — the reference's `resolve_outcome` also resolves semantic-edge UIDs and route handlers; this package has no such row surfaces, so those passes are omitted.
- **The loader hook is synchronous** — `loadSymbolsForFiles` must populate the catalog synchronously (the store lane's SQLite reads are synchronous, so this fits); an async loader would need an API revision.
- **Stores built earlier in Phase 2 carry stale id values** — per-occurrence ids changed encoding and the store-side dedupe pass landed mid-Phase-2, so rows written by earlier builds keep the old id semantics; rebuild such a store once with `refresh({ forceRebuild: true })`.
