# @relay-harness/rlh-tool-code-index

English | [中文](README.zh.md)

The **model-facing consumer of the local code-index capability** (`ctx.codeIndex`): `search_code_index` ranks indexed workspace chunks with self-explaining reasons, `explore_code_graph` answers structured questions over the derived call graph, `code_index_status` reports seam health, and `refresh_code_index` brings the derived index up to date (or forces a rebuild). The package owns schemas, argument validation, exit-side output budgeting, prompt guidance, and presentation; storage, scanning, ranking, and concurrency folding stay in whichever provider backs the seam.

Function plugin (`name` / `inject` / `Config` / `apply`, no default export). Injects `tools` and `systemPrompt`; the seam is deliberately NOT injected — every execute resolves it through `ctx.get('codeIndex')`, so compositions without an index provider load cleanly and fail individual calls as structured `INDEX_TOOL_UNAVAILABLE`.

```ts ignore-check
// The provider supplies ctx.codeIndex; this Consumer rides on top of it.
await ctx.plugin(LocalCodeIndexProvider)                    // the provider package for your backend
await ctx.plugin(ToolCodeIndex, { clampTopKToTier: false }) // @relay-harness/rlh-tool-code-index
```

The exit-side byte cap ports the reference implementation's `ExitPolicy` design: a protection layer at ONE boundary, not a correctness layer. Engine ranking and tier clamps remain the honest bound; enforcement reads the budget AFTER execution from the answer's own repository-size tier, mirroring the cached-tier semantics of the source material.

## Config

| Key | Default | Meaning |
|---|---|---|
| `clampTopKToTier` | `false` | When true, the model-facing `top_k` lever disappears from `search_code_index`'s schema and an explicit value is dropped, so the engine's repository-size-tier cap always decides hit count. |

## Tools

| Tool | Arguments | Behavior |
|---|---|---|
| `search_code_index` | `query`, `path_prefix?`, `top_k?`, `paths?`, `recent_paths?`, `include_grep?` | Ranked chunk retrieval over indexed spans. Arguments map onto the seam's camelCase request (`pathPrefix`, `recentPaths`, `topK`); `include_grep: false` forwards an advisory grep-lane hint providers may ignore. Results are deterministic for an unchanged epoch pair and self-explaining via `reasons` tokens. |
| `explore_code_graph` | `op`, `symbol?`, `file_path?`, `direction?`, `depth?`, `files?`, `include_tests?`, `max?` | Structured graph questions over the derived call graph: `op=relations` walks callers and/or callees of one symbol (depth 1–2, `file_path` pins a shared name), `op=impact` sweeps reverse reachability of a symbol or file set with the impacted tests attached (`include_tests: false` drops them), `op=tests` maps code files to the tests exercising them, `op=cycles` reports circular file-import components largest first (`max` caps components after the size-descending order, so truncation keeps the largest cycles), and `op=dead_code` lists symbols with no incoming callers or external references (`max` caps the list; the candidate scan runs a bounded `min(40 × max, 5000)` superset). Illegal cross-op combinations (`files` on relations, `direction` on tests, an empty `files` list) are ordinary argument errors; a symbol that resolves to nothing returns an empty answer with a `symbol_not_found: <name>` entry in `explain.readErrors`.
| `code_index_status` | none | Zero-argument health report: indexed file count, tier, current epochs, last-refresh summary, degraded flag. Naturally bounded. |
| `refresh_code_index` | `force?` | Incremental up-to-date pass over the workspace tree; `force: true` rebuilds from scratch. Concurrent passes fold into one commit inside the seam. |

Rendering is compact by construction: hits print one line each as `path:start-end score reasons`, explore answers print a tier-labeled op header, one line per node (`role kind name @ file:start`), one line per edge (`caller: X → Y (f:line)`, the enrichment template), one line per test pair (`test: spec → code (reason)`), one line per cycle component (`size n: a → b → c`), one line per dead-code candidate (`dead: kind name @ file (reason)`), an `explain: declared=[...] candidates=N` summary, and a `(truncated: <reason>; N candidates considered)` footer only when a cap clipped the answer; status prints deterministic `key: value` lines, and refresh prints a labeled summary ending with the post-commit `indexEpoch`. A response whose serialized JSON exceeds the tier budget (`repoSizeTierMaxOutputChars`: 18000/24000/32000/38000 bytes) returns the truncation envelope `{ _truncated, _original_chars, _max_chars, partial }` as the canonical value, rendered as recovery prose that never unfolds the partial payload back into context.

## Errors

Failures carry `{ name, code }` metadata on `isError` results: `INDEX_TOOL_UNAVAILABLE` (no `ctx.codeIndex` loaded), `INDEX_TOOL_REFRESH_IN_PROGRESS` (a second tool-driven pass arrived while one is still awaited — immediate structured feedback instead of queueing behind the fold), and `INDEX_TOOL_FAILED` (the provider threw something without a stable `HarnessError` code; original attached as `cause`). Stable provider vocabulary such as `CODE_INDEX_NOT_INDEXED` propagates unchanged so callers route on the same codes the seam defines. Model argument mistakes (blank `query`, non-positive `top_k`, `explore_code_graph` cross-op illegal combinations) stay ordinary tool argument errors.

## Model Experience

### System prompt

#### What the model sees

One fixed section (name `tool:code-index`, order 107, between filesystem discovery and shell tools) explaining when to prefer the index over raw scanning:

##### Verbatim text

```markdown
Prefer search_code_index over grep/glob when locating the symbols, declarations, or chunks relevant to a change question: it ranks indexed spans with explanations and costs far less than raw scanning. Once you know the symbols involved, use explore_code_graph for cross-file structure questions: it walks callers and callees of a symbol, sweeps what a change would break together with its impacted tests, maps files to the tests that cover them, and surfaces circular import cycles and never-called symbols. Use grep/glob instead for exact literals and formats the index may not cover, or when you need every occurrence. If results look stale after edits, check code_index_status for the current epoch and call refresh_code_index (force only to rebuild from scratch) before blaming the index for a miss.
```

#### Token effect

Fixed cost on every request while the plugin scope is active; agent-scoped restriction of any schema does not remove the section.

#### KV Cache effect

Prefix-stable while the section text and position are unchanged; disposal or future wording changes invalidate reuse from this section's first changed token.

### search_code_index

#### What the model sees

The generated [`search_code_index` schema](../../../docs/tool-catalog.md#relay-harnessrlh-tool-code-index), then either compact ranked lines (`path:start-end score reasons`) under a tier-labeled header, `[degraded]` reason notes whenever `readErrors` is non-empty, a candidate-count footer exactly when the engine truncated ranking, or — past the tier byte cap — recovery prose describing the truncation envelope instead of the payload.

#### Token effect

Bounded twice: engine top-K keeps hit counts small, and the exit byte cap bounds the complete serialized answer; routine answers stay orders of magnitude below it while errors add a short message.

#### KV Cache effect

Append-only; tool results follow the reusable request prefix and do not invalidate existing entries.

### explore_code_graph

#### What the model sees

The generated [`explore_code_graph` schema](../../../docs/tool-catalog.md#relay-harnessrlh-tool-code-index); execution returns the complete `GraphExploreResult` — nodes, edges, optional test pairs, cycle components with their witness edges, dead-code candidates, and the explain envelope under the epoch pair the answer was read at — rendered as the compact node/edge/test/cycle/dead lines described above, or recovery prose past the tier byte cap.

#### Token effect

Bounded twice: the request's `max` (and the tier's per-seed enrichment windows, test-pair cap, and the analysis ops' own caps) keep answers small at the source, and the exit byte cap bounds the complete serialized answer.

#### KV Cache effect

Append-only; tool results follow the reusable request prefix and do not invalidate existing entries.

### code_index_status

#### What the model sees

The generated [`code_index_status` schema](../../../docs/tool-catalog.md#relay-harnessrlh-tool-code-index); execution returns deterministic `key: value` lines including `indexEpoch`, plus the last refresh summary when one has committed.

#### Token effect

Small fixed-shape report per call; the natural bound IS the shape, so no exit cap applies.

#### KV Cache effect

Append-only; newly visible content follows the reusable prefix.

### refresh_code_index

#### What the model sees

The generated [`refresh_code_index` schema](../../../docs/tool-catalog.md#relay-harnessrlh-tool-code-index); success renders a labeled summary ending in `indexEpoch now: N`, visible to the next `code_index_status` call because the report reads the same committed clock. Concurrency answers `INDEX_TOOL_REFRESH_IN_PROGRESS` immediately rather than promising a later duplicate summary.

#### Token effect

One small fixed-shape summary per completed pass; busy calls cost one short error line.

#### KV Cache effect

Append-only; newly visible content follows the reusable prefix.

## Known Limitations and Deferred Work

- **`include_grep` is an advisory hint** — the field rides on the outbound request ahead of the seam's `SearchRequest` type growing it; providers predating the field ignore it and behave as if true.
- **The byte-cap budget measures UTF-8 bytes** although the tier constant is named `maxOutputChars` (ported verbatim from the reference implementation); multibyte content hits the cap earlier than a character count would suggest.
- **The refresh busy guard is process-local** — two plugin instances in one Cordis tree would each guard their own passes; deployments are expected to mount this Consumer once.
