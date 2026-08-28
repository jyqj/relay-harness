# @relay-harness/rlh-code-index

English | [中文](README.zh.md)

The **`CodeIndex`** (`ctx.codeIndex`) defines WHAT a local code-index backend does — report health, refresh a derived on-disk index of the current workspace, and run deterministic hybrid retrieval over indexed chunks — without saying HOW any of it is stored, scanned, or ranked.

This package is one third of the code-index capability, split so each concern evolves (and swaps) independently:

| Package | Role |
|---|---|
| `@relay-harness/rlh-code-index` (this) | Service Definition: abstract service + vocabulary types + repository-size tiers |
| `@relay-harness/rlh-code-index-local` | Service Provider: workspace scanner, incremental diff, generic chunker, SQLite-backed index |
| `@relay-harness/rlh-tool-code-index` | Consumer: the model-facing `search_code_index` / `code_index_status` / `refresh_code_index` tools |

All three packages ship in `packages/index/`; this seam owns the shared schema every role compiles against.

## Service API (`ctx.codeIndex`)

| Member | Semantics |
|---|---|
| `status()` | Read-only health report: indexed file count, resolved `RepoSizeTier`, epoch pair, last refresh summary, degraded flag. No side effects. |
| `refresh(options?)` | Bring the derived index up to date with the workspace tree, or force a full rebuild. Concurrent calls fold into the single in-flight pass; summaries are published only after that pass commits. |
| `search(request, signal?)` | Deterministic hybrid retrieval over indexed chunks. Results carry the epoch pair they were read under plus a `degraded` flag; consumers must treat every result whose `readErrors` is non-empty as unfit for caching. |
| `exploreGraph(request, signal?)` | Answer one structured graph question (`relations` / `impact` / `tests` / `cycles` / `dead_code`) over the derived call graph. Answers carry nodes, edges, optional test pairs, cycle components, dead-code candidates, and the explain envelope under the epoch pair they were read at; every rendered edge's endpoints resolve inside the answer's `nodes`. |

## Vocabulary

An `EpochPair` is two monotonic clocks: `indexEpoch`, advanced exactly once per committed content-bearing write transaction, and `evidenceEpoch`, reserved for semantic-evidence ingestion. Cache keys anywhere above the seam must include both values — an epoch-stale cache entry is stale even if its bytes look identical. A `RepoSizeTier` (`tiny` / `small` / `medium` / `large`, classified by file count at the 500 / 5000 / 25000 boundaries) is the single source of adaptive constants (`src/tiers.ts`): search top-K caps, output character budgets, snippet budgets, token budgets, and graph-enrichment limits are functions of the tier, not of call sites. A `SearchResult` is bounded and self-describing: hits rank deterministically (score descending, ties broken by ascending chunk id), each hit explains itself through `reasons` tokens, `truncated` distinguishes budget cuts from exhausted ranking, and an optional `graphScore` carries the connectivity score assigned by graph enrichment (absent without graph context). The graph explore vocabulary (`GraphExploreRequest` / `GraphExploreResult` and its node/edge/test/cycle/dead-code/explain views) names the relation, impact, test, cycle, and dead-code questions providers will answer over the derived graph, bounded by the tier's graph-enrich limits and the ops' own caps. See `src/types.ts` for the full contracts.

## Model Experience

Indirectly, through the `search_code_index`, `explore_code_graph`, `code_index_status`, and `refresh_code_index` tools provided by `@relay-harness/rlh-tool-code-index`.

#### KV Cache effect

No direct request-prefix changes; consumers own how retrieval output enters a conversation.

## Known Limitations and Deferred Work

- **The seam carries the tier constants with current consumers** — search caps, output/snippet and token budgets, and graph-enrich limits; every table has a consuming phase on the retrieval path.
- **`evidenceEpoch` is a read-only placeholder** until semantic-evidence ingestion provides a writer.
- **`RefreshSummary` does not yet expose per-path detail** — aggregate counts only, by design, to keep every exit bounded.
