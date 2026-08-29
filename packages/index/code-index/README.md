# @relay-harness/rlh-code-index

English | [中文](README.zh.md)

The **`CodeIndex`** (`ctx.codeIndex`) defines WHAT a local code-index backend does — report health, refresh a derived on-disk index, rank candidates, hydrate current-source-verified chunk bodies, and explore the derived graph — without saying HOW any of it is stored, scanned, or ranked.

This package is one third of the code-index capability, split so each concern evolves (and swaps) independently:

| Package | Role |
|---|---|
| `@relay-harness/rlh-code-index` (this) | Service Definition: abstract service + vocabulary types + repository-size tiers |
| `@relay-harness/rlh-code-index-local` | Explicit single-workspace Provider: scanner, incremental diff, chunker, SQLite index |
| `@relay-harness/rlh-code-index-workspace-router` | Multi-Workspace Provider: canonical routing, isolated local runtimes/stores, bounded lifecycle |
| `@relay-harness/rlh-tool-code-index` | Consumer: the model-facing `search_code_index` / `code_index_status` / `refresh_code_index` tools |

All three packages ship in `packages/index/`; this seam owns the shared schema every role compiles against.

## Service API (`ctx.codeIndex`)

| Member | Semantics |
|---|---|
| `forWorkspace(workspaceRoot)` | Bind all following reads and mutations to one caller-selected canonical Workspace; the Web provider rejects unscoped operations. |
| `status()` | Read-only health report: indexed file count, resolved `RepoSizeTier`, epoch pair, last refresh summary, degraded flag. No side effects. |
| `refresh(options?)` | Bring the derived index up to date with the workspace tree, or force a full rebuild. Concurrent calls fold into the single in-flight pass; summaries are published only after that pass commits. |
| `search(request, signal?)` | Deterministic hybrid retrieval over indexed chunks. Results carry the epoch pair they were read under plus a `degraded` flag; consumers must treat every result whose `readErrors` is non-empty as unfit for caching. |
| `hydrateChunks(request, signal?)` | Batch-resolve full indexed bodies after revalidating each backing source against its stored content hash. Stale, missing, and unreadable identities return as explicit rejections, never bodies. |
| `exploreGraph(request, signal?)` | Answer one structured graph question (`relations` / `impact` / `tests` / `cycles` / `dead_code`) over the derived call graph. Answers carry nodes, edges, optional test pairs, cycle components, dead-code candidates, and the explain envelope under the epoch pair they were read at; every rendered edge's endpoints resolve inside the answer's `nodes`. |

## Vocabulary

An `EpochPair` carries the observed monotonic clocks: `indexEpoch` for index-content transactions, `embeddingEpoch` for vector batches, and reserved `evidenceEpoch` for future runtime evidence. Cache keys above the seam include the observed snapshot. A `RepoSizeTier` (`tiny` / `small` / `medium` / `large`, classified by file count at the 500 / 5000 / 25000 boundaries) owns the adaptive constants in `src/tiers.ts`. A `SearchResult` is bounded and self-describing: hits carry file content hashes, actual parser tier/confidence, an ordered additive `scoreTrace`, deterministic `reasons`, and optional graph connectivity score without carrying source bodies. `HydrateChunksResult` returns those bodies separately only after current-source verification, preserving candidate-cache bounds and giving evidence consumers a per-resource revision. The graph explore vocabulary names the relation, impact, test, cycle, and dead-code questions providers answer over the derived graph. See `src/types.ts` for the full contracts.

## Model Experience

Indirectly, through the `search_code_index`, `explore_code_graph`, `code_index_status`, and `refresh_code_index` tools provided by `@relay-harness/rlh-tool-code-index`.

#### KV Cache effect

No direct request-prefix changes; consumers own how retrieval output enters a conversation.

## Known Limitations and Deferred Work

- **The seam carries the tier constants with current consumers** — search caps, output/snippet and token budgets, and graph-enrich limits; every table has a consuming phase on the retrieval path.
- **`evidenceEpoch` is a read-only placeholder** until semantic-evidence ingestion provides a writer.
- **`RefreshSummary` does not yet expose per-path detail** — aggregate counts only, by design, to keep every exit bounded.
