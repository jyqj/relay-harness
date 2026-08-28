# index/ — local code-index capability family

English | [中文](README.zh.md)

Plugins that build a derived, on-disk code index of the current workspace and expose deterministic hybrid retrieval to the model. All members are opt-in.

| Package | Role | ctx key |
|---|---|---|
| [`code-index/`](code-index/README.md) | Retrieval seam: abstract service, vocabulary types, and repository-size tiers | `ctx.codeIndex` |
| [`code-index-sqlite/`](code-index-sqlite/README.md) | SQLite index store: schema, fail-closed open with rebuild-on-mismatch, chunk-text codec | — |
| [`code-index-search/`](code-index-search/README.md) | Ranking engine: lane/preselect registries, lexical + grep lanes, RRF fusion, deterministic rerank | — |
| [`code-index-local/`](code-index-local/README.md) | Local provider: workspace scan, `.gitignore` stacking, incremental diff, generic 80-line chunker, tool-result invalidation | — |
| [`tool-code-index/`](tool-code-index/README.md) | Model-facing tools: `search_code_index`, `code_index_status`, `refresh_code_index`, with tier-scaled exit budgets | — |

Retrieval is bounded by repository-size tiers (`tiny`/`small`/`medium`/`large`) with constants owned by the seam; every model-facing exit applies a tier-scaled budget. Results carry an epoch pair; anything whose `readErrors` is non-empty is degraded and must never be cached.
