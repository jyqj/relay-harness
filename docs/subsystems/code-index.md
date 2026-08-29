# Local Code Index

English | [中文](code-index.zh.md)

The local code-index capability builds a derived, on-disk index of the current workspace and exposes deterministic hybrid retrieval to the model. It is a [capability seam](../../docs/glossary.md#capability-seam) whose Service Definition ([rlh-code-index](../../packages/index/code-index), `ctx.codeIndex`) reports health, refreshes the derived index, and runs retrieval without saying how any of it is stored, scanned, or ranked. The index is **one optional capability**, not part of the agent-loop spine — its vocabulary lives here, not in [core.md](core.md).

Source: [`packages/index/code-index/src/types.ts`](../../packages/index/code-index/src/types.ts)

## Packages and roles

| Package | Role | Wiring |
|---|---|---|
| [`rlh-code-index`](../../packages/index/code-index) | Service Definition: abstract `CodeIndex`, vocabulary types, repository-size tiers | declares `ctx.codeIndex` |
| [`rlh-code-index-local`](../../packages/index/code-index-local) | Explicit single-workspace Provider: scanner, diff, chunker, storage/retrieval | fills `ctx.codeIndex` in headless compositions |
| [`rlh-code-index-workspace-router`](../../packages/index/code-index-workspace-router) | Multi-Workspace Provider: canonical routing, per-workspace runtime/database, LRU/idle lifecycle | fills `ctx.codeIndex` in Web/Desktop |
| [`rlh-code-index-sqlite`](../../packages/index/code-index-sqlite) | Storage repository: six-table SQLite schema, epoch-bumped writes, retrieval port adapter | library, no service |
| [`rlh-code-index-parser`](../../packages/index/code-index-parser) | AST parsing: web-tree-sitter walkers turning file text into symbol/import/call-edge/literal records | library, no service |
| [`rlh-code-index-search`](../../packages/index/code-index-search) | Retrieval domain engine: preselect layers, lexical/grep lanes, RRF fusion, rerank | library, no service |
| [`rlh-code-index-graph`](../../packages/index/code-index-graph) | Symbol graph domain: resolver catalog and ladder, graph lane/enrichment, dirty propagation | library, no service |
| [`rlh-tool-code-index`](../../packages/index/tool-code-index) | Consumer: the model-facing `search_code_index` / `explore_code_graph` / `code_index_status` / `refresh_code_index` tools | injects `tools` + `systemPrompt`, reads `ctx.get('codeIndex')` at execution time |

The Consumer resolves the seam through `ctx.get('codeIndex')` rather than injection, so compositions without a provider load cleanly and fail individual calls as structured `INDEX_TOOL_UNAVAILABLE`.

## Data flow

One refresh pass scans the workspace breadth-first with bounded concurrent stat work, classifies each file against the committed generation with an mtime+size fast path (hash-confirmed through an eight-way bounded read for suspects), and reads/parses changed files with deterministic four-way concurrency before the five-stage pipeline — parse, resolve, write, test-edge rebuild, dirty propagation (the last two only on incremental passes). Each stage's writes land in its own epoch-bumped transaction, so a pass's epoch advance counts its commits exactly. A search runs the retrieval engine's preselect fold and lanes — with the graph lane and connectivity rerank last — over the store's retrieval port, reads the epoch pair from the store ledger into the answer, and the tool consumer caps the complete serialized answer at one exit boundary before it becomes model context.

## Epochs

Every result is read under an `EpochPair`. `indexEpoch` advances per committed index-content transaction, `embeddingEpoch` per committed vector batch, and `evidenceEpoch` remains reserved for future runtime-evidence ingestion. Audited commits must advance exactly their declared channel and freeze the other two. Cache keys above the seam include the observed clock snapshot; the three ledger rows are seeded at `'0'`, survive reopening, and fail loudly when missing or unparsable.

## Repository-size tiers

`RepoSizeTier` (`tiny` / `small` / `medium` / `large`, classified by indexed file count) owns every adaptive constant. Constants live only in `packages/index/code-index/src/tiers.ts`, except the store's cache capacity, which is the storage package's own decision:

| Tier | File count | Search top-K | Output cap (bytes) | Chunk-text cache slots |
|---|---|---|---|---|
| `tiny` | < 500 | 5 | 18000 | 128 |
| `small` | < 5000 | 10 | 24000 | 256 |
| `medium` | < 25000 | 15 | 32000 | 384 |
| `large` | ≥ 25000 | 20 | 38000 | 512 |

The snippet budget is `floor(output / 3)` at every tier, so consumers embedding snippets inside larger envelopes keep room for wrapper metadata.

## The service (`ctx.codeIndex`)

`status()` reports indexed file count, resolved tier, epoch pair, last refresh summary, and the degraded flag without side effects. `refresh(options?)` folds concurrent calls into one in-flight pass and publishes its `RefreshSummary` only after that pass commits. `search(request, signal?)` returns ranked candidates with content revisions, parser provenance, and additive score traces under the epoch pair they were read at; a `degraded` flag with non-empty `readErrors` marks results unfit for caching. `hydrateChunks(request, signal?)` separately resolves full indexed bodies, re-hashes each distinct current backing file, and returns stale, missing, or unreadable identities only as explicit rejections, keeping source bytes out of search caches. `exploreGraph(request, signal?)` answers the five graph questions `relations` / `impact` / `tests` / `cycles` / `dead_code` under the epoch pair they were read at (see [The explore_code_graph tool](#the-explore_code_graph-tool)); every edge's endpoints resolve inside the answer's `nodes`.

```ts type-equiv
/** Model-shaped retrieval request against the local code index. */
interface SearchRequest {
  /** Raw search text; interpreted as identifier/path tokens plus free words. */
  readonly query: string
  /** Restrict ranking to these exact file paths (explicit scope). */
  readonly paths?: readonly string[]
  /** Files the model recently worked with; boosts their preselect score. */
  readonly recentPaths?: readonly string[]
  /** Files in the caller's active working set; boosts preselection and reranking. */
  readonly boostFilePaths?: readonly string[]
  /** Prior queries, oldest to newest; the latest four bias lexical retrieval. */
  readonly conversationQueries?: readonly string[]
  /** Caller-pinned context files; boosts preselection and reranking. */
  readonly pinnedFilePaths?: readonly string[]
  /** Dirty-buffer or overlay-neighbor files; boosts preselection and reranking. */
  readonly overlayFilePaths?: readonly string[]
  /** Restrict candidates to file paths starting with this prefix. */
  readonly pathPrefix?: string
  /** Requested hit count; the engine caps it by the repository-size tier. */
  readonly topK?: number
}
```

```ts type-equiv
/** Request for one ordered batch of full indexed chunk bodies. */
interface HydrateChunksRequest {
  /** Chunk identities to resolve; duplicates are returned once at their first position. */
  readonly chunkIds: readonly string[]
}
```

```ts type-equiv
/** Complete batch-hydration answer under one observed provider generation. */
interface HydrateChunksResult {
  /** Resolved chunks in first-occurrence request order. */
  readonly chunks: readonly HydratedChunk[]
  /** Requested identities rejected as stale or unavailable, in first-occurrence order. */
  readonly rejected: readonly ChunkHydrationRejection[]
  /** Epoch pair observed after the synchronous store read. */
  readonly epochs: EpochPair
}
```

## Retrieval pipeline

`createSearchEngine({ port })` runs fixed stages in order — plan build, serial lanes in registry order, RRF fusion, additive rerank, deterministic finalize — as pure logic over the `RetrievalPort`; no module touches fs, SQL, or clocks. Numeric constants port verbatim from `packages/index/code-index-search/src/config.ts`:

- **Preselect** folds the default layers (working-set/recent/pinned/overlay rank decay, FTS summaries, per-token symbol/path matching, gated fallback) and normalizes the query, filter, and tier-capped top-K. Explicit `paths` scope scores 10.0. The filter DSL parses all four keys — see [The filter DSL and the literal lane](#the-filter-dsl-and-the-literal-lane).
- **Lanes**: `createLexicalLane` (bm25-ordered FTS matching, candidate cap 24), `createGrepLane` (recency-ordered scans capped at 20000 rows, candidate cap 12), and the graph, literal, and vector lanes described under [Phase 3](#phase-3-dsl-literals-vectors-analysis-ops-and-heuristic-languages). New lanes and preselect layers register via `defineRetrievalLane` / `definePreselectLayer`; assembly validates unique ids and at least one enabled lane at construction, never mid-search.
- **Fusion**: reciprocal-rank fusion with `k = 50` and lane weights 1.1 (lexical) / 0.8 (grep); fused totals window to the rerank window of 40 candidates.
- **Rerank** adds a traced table onto each candidate: query-overlap ×0.35, doc-file +0.08, path-prefix +0.05, working-set +0.22, recent-file +0.12, pinned-context +0.20, overlay-neighbor +0.10, and `min(stage-a × 0.04, 0.25)` as the stage-a floor. The `symbol-exact` bonus (+0.18) rides `FeatureGates.symbolExactEnabled`, on by default now that every semantic-tier chunk carries symbol names.
- **Finalize** sorts by score descending with ties broken by ascending chunk id, under the tier's output-character budget.

Determinism is structural: fixed stage order, construction-time registry validation, and a snapshot-stable sort mean the same request against an unchanged epoch pair returns the same hits. Every additive component emits a `reasons` token, so each hit explains itself; `truncated` distinguishes budget cuts from exhausted ranking.

## Storage layout

The schema (`src/ddl.ts` in [rlh-code-index-sqlite](../../packages/index/code-index-sqlite)) keeps the chunk core (`metadata` as the key-value epoch ledger, `files` / `chunks` as STRICT row sources with chunks cascade-deleting beside their file), three FTS5 mirrors (`chunks_fts`, `files_fts` with `unicode61 remove_diacritics 2`, and trigram `file_paths_fts`), and the v2 graph tables described under [AST parsing and the symbol graph](#ast-parsing-and-the-symbol-graph-phase-2). Application-side maintenance mirrors deletes through base tables BEFORE the doomed rows disappear and re-mirrors inserts under the base row's own rowid; only `file_paths_fts` heals itself through triggers alone.

Admission fails closed: a foreign `application_id` (or user tables under no registered id) rejects the file untouched with `CODE_INDEX_DB_FOREIGN_APPLICATION`; an admitted store with an out-of-range version or unrecognized tables rebuilds in place instead of migrating — every table is reconstructable derived data. Missing directories and files are created owner-only (`0700`/`0600`). The codec registers `'plain'` and `'zstd'` (a Zstandard level-3 frame stored as base64 text, chosen when compression shrinks a payload past the 128-byte threshold); an unrecognized stored tag, or a `'zstd'` payload that fails to decompress, throws rather than guessing, and the `chunks_fts` mirror always holds the decoded text. Decoded chunk text lands in an LRU cache keyed on `(index_epoch, chunks.rowid)`, so any commit invalidates naturally, and degraded read results never enter. The reader (`createRetrievalPort`) implements the search package's port over raw SQL — bm25 ordering, scope filters as WHERE clauses with escaped LIKE metacharacters, streamed per-row lazy decoding — while scan budgets stay on the search side.

## Provider pipeline

[rlh-code-index-local](../../packages/index/code-index-local) assembles scan, diff, chunk, and storage for one workspace:

- **Exclusion combines static and hierarchical layers** — the 15 built-in hard excludes and explicit config `exclude` patterns stay static; every pass discovers root and nested `.gitignore` documents, applying matching rules root-to-leaf so deeper negation can override an ancestor. Excluded directories prune before descent, file candidacy remains the fixed 27-entry include-glob table, and symlinks never expand traversal.
- **Diff** trusts mtime+size as a fast path and re-reads suspicious candidates once for hash confirmation, suppressing touch false positives and mtime jitter.
- **Chunking** cuts accepted files into line windows of at most 80 lines (`generic` parser tier, confidence 0.5); undecodable payloads skip as binary, files over `maxFileBytes` (default 512000) record their row without chunks, and first-window text backs `files.summary` / `content_excerpt`.
- **Store path** defaults to `<rlhHome>/index/code-index-<hash>.sqlite3`, where `<hash>` is the first twelve SHA-256 hex characters of the workspace real path; `$RLH_HOME` or an explicit `databasePath` overrides it. Other knobs: `workspaceRoot` (process cwd), `journalMode` (`wal`), `debounceMs` (500), `watcherEnabled` (`false`). Misconfiguration fails loud at load.

## AST parsing and the symbol graph (Phase 2)

[rlh-code-index-parser](../../packages/index/code-index-parser) turns one accepted file's text into the extraction records the derived index stores: symbols, imports, call edges, and string literals. Nine web-tree-sitter grammar WASMs cover ten language names (`jsx` parses with the JavaScript grammar); they load once per process from `resources/grammars/`, with the upstream release URL and exact byte size of every artifact pinned in `resources/grammars/VERSION`. The artifacts are the official tree-sitter release builds because the `tree-sitter-wasms` npm package ships legacy `dylink.0` sections that web-tree-sitter ≥ 0.25 cannot load. Walker coverage sets the parser tier: the JS/TS family, Python, and Rust walk at `semantic` (confidence 0.85), Go, Java, and C/C++ at `tree-sitter` (0.7). Web-tree-sitter exposes no parse-interrupt hook, so there is no timeout API — a pathological file costs one `parseErrors` entry, never a stuck pass. Identifiers are content-derived sha256 prefixes (`uid:` keyed on file plus qualified name, so line drift keeps the id and a signature change moves it), a deliberate deviation from the reference's position-derived ids.

### Resolution ladder

Unbound call edges resolve against a long-lived in-process `SymbolCatalog` (batch-loaded from the `symbols` table, evicted per changed batch) through the fixed nine-step ladder `self_member → scope_binding → same_file → import → suffix → global_unique → fuzzy_arg_count → fuzzy_receiver → fuzzy_import_distance`. Every strategy name carries a default confidence (exact 1.0, qualified 0.95, scope 0.9, import 0.85, global-unique 0.75, suffix 0.65, fuzzy-signal 0.55, heuristic 0.5, fuzzy tiers down to 0.3, unresolved 0) stored on the edge as `resolution_kind` / `resolution_confidence` / `resolution_strategy`; the fuzzy steps use parser-derived call-site signals (argument count, receiver text, import distance) so call-site evidence outranks pure name proximity.

### Graph storage

The v2 graph tables — `symbols`, `imports`, `call_edges`, `symbol_refs`, `test_edges`, `literal_index`, and the `symbols_fts` trigram mirror — ride the same delta transactions as the chunk core, so a batch's symbols, edges, and fingerprints commit atomically under one epoch bump. Re-resolution binds an edge to its target's `symbol_id` / `symbol_uid` through the ladder; a removed or renamed target rolls the importer's edge back to the pristine unresolved state. Test edges are path-derived only (`same-basename` at 0.9, `path-overlap` at 0.7) and rebuild only on an incremental pass whose path set changed — a full build writes none, and a pure content rewrite leaves the committed edges untouched.

### Retrieval enrichment

The search engine assembles the graph lane (RRF rank positions) and the graph-neighbor preselect layer behind the lexical/grep lanes, and every search runs `searchWithGraphContext`: top hits resolve to symbol uids, one degree/ref batch computes the connectivity score `min(ln(in+out+1)/10 + min(refs,10)/100, 0.4)`, and assigned hits take `score += graphScore × 0.3` with the `boost:graph-rerank` reason token before the single final sort. Answers carry the optional `graphScore` per hit; the epoch-pair-keyed result cache (32 entries, degraded outcomes never cached) keeps repeat queries off the enrichment reads.

### The explore_code_graph tool

`exploreGraph` on the seam answers three questions over the same tables, assembled in the provider's `src/explore.ts`: `relations` walks callers and/or callees of one symbol at depth 1–2 (the port reads the seed side, so callers come back through `calleeRowsByUids`), `impact` sweeps the reverse reachability of a symbol or file set with the impacted test pairs attached, and `tests` maps code files to the pairs exercising them. Per-seed edge windows reuse the tier's enrichment caps; a request's `max` caps the rendered nodes globally (targets first, then edge endpoints — the first refused add stops rendering and records `max_nodes`); test pairs cap at the tier's `maxTests` (`result_limit` when cut). A target that resolves to nothing returns an empty answer with a `symbol_not_found: <name>` entry in `explain.readErrors` — a degradation, not a truncation — and store failures propagate as structured tool errors instead of degrading.

```ts type-equiv
/** Model-shaped graph question against the derived code graph. */
type GraphExploreRequest =
  | {
    /** Walk callers and/or callees of one symbol. */
    readonly op: 'relations'
    /** Symbol name to resolve; providers disambiguate with {@link GraphExploreRequest.filePath}. */
    readonly symbol: string
    /** Pin the symbol to this file when several declarations share the name. */
    readonly filePath?: string
    /** Which side to walk; defaults to provider policy when omitted. */
    readonly direction?: GraphRelationDirection
    /** Walk depth; this phase supports `1` and `2`. */
    readonly depth?: 1 | 2
    /** Requested node/edge cap; the tier's graph-enrich limits still bound the answer. */
    readonly max?: number
  }
  | {
    /** Reverse-reachability sweep answering "what breaks if this changes". */
    readonly op: 'impact'
    /** Symbol to sweep; omit when {@link GraphExploreRequest.files} pins the seeds instead. */
    readonly symbol?: string
    /** Files whose reverse dependencies join the sweep. */
    readonly files?: readonly string[]
    /** Whether impacted tests join the answer. */
    readonly includeTests?: boolean
    /** Requested cap before tier limits. */
    readonly max?: number
  }
  | {
    /** Map code files to the tests that exercise them. */
    readonly op: 'tests'
    /** Code files to map. */
    readonly files: readonly string[]
    /** Requested pair cap before tier limits. */
    readonly max?: number
  }
  | {
    /**
     * Detect circular dependency components over the file-import graph
     * (iterative Tarjan SCC; components of size 1 — including self-imports —
     * are not cycles and never surface).
     */
    readonly op: 'cycles'
    /**
     * Requested component cap. Components order by size descending before the
     * cap cuts, so truncation always keeps the largest cycles.
     */
    readonly max?: number
  }
  | {
    /** List symbols with no incoming callers and no external references. */
    readonly op: 'dead_code'
    /**
     * Requested item cap. The candidate scan runs a bounded superset
     * (`min(40 × cap, 5000)` symbols) before the cap cuts the answer.
     */
    readonly max?: number
  }
```

### Dirty propagation

Incremental passes compute a sha256 export fingerprint per changed file (its export surface), diff it against the pre-write value, and re-resolve the transitive importer closure through the import graph — bounded per pass by `dirtyPropagationMaxFiles` (default 200) and at most `DIRTY_CLOSURE_MAX_ROUNDS` rounds, with re-export chains folded into the closure. The reload policy classifies each promoted file's edges (unresolved seeds re-run the full ladder, previously bound edges re-verify their target first), so a renamed export rebinds instead of accumulating stale rows.

## Phase 3: DSL, literals, vectors, analysis ops, and heuristic languages

### The filter DSL and the literal lane

The query DSL parses four keys — `kind:` / `lang:` / `path:` / `name:` — with case-insensitive keys and quoted or bare values; unknown `foo:` tokens stay free text, an empty value is consumed but unset, and a repeated key keeps its first value (a named divergence from the reference's last-write). `kind:` normalizes through the symbol-kind matcher, `lang:` filters on the parser's language name (an unknown name filters nothing, exactly like the reference's `Language::from_name`), and `name:` rides the rerank as a +0.25 bonus carrying the `dsl-name:` reason token.

The literal lane (weight `search.literal_weight`, default 0.9) runs bm25-ordered FTS5 `MATCH` over the `literal_fts` mirror (schema v3) and attributes each hit line to the chunk whose span owns it — the fusion pipeline only knows chunk identities. JS/TS literals, including SFC script blocks, pass a priority-ordered classifier onto a nine-kind vocabulary (`route`, `url`, `topic`, `queue`, `env_key`, `config_key`, `sql`, `error_string`, `log_key`); an unclassifiable literal is not recorded at all, and Python and Rust emit no literal rows. The lane requires the port's optional `literalFtsCandidates` facet and disables itself without it, so pre-literal adapters keep working unchanged.

### The vector recall tier

Schema v8 adds `embedding_generations`, whose durable identity covers provider, credential-free endpoint, model, dimension mode, normalization, quantizer, and chunker. `chunks_vec` stores one int8 vector per `(chunk_id, generation_id)` and `code_embed_jobs` enqueues idempotently per `(chunk_id, generation_id, content_hash)`. Jobs and vectors cascade with their chunk or generation; `result_json` remains NULL and `usage_json` records allocated provider spend. Current-content terminal failures receive one durable `reconcile_resets` reset, so reconciliation repairs a transient terminal failure without retrying forever.

Quantization is symmetric per-vector int8: the largest absolute component maps to 127, keeping the range `[-127, 127]`. Ranking never materializes a dequantized vector — `cosineQuantized` computes `cosine = (scale · Σ query[i]·q[i]) / (|query| · norm)` directly over the int8 bytes, and its precision comes from accumulating exact small integers times float query components; a result can exceed 1 by the quantization error, so callers needing a strict unit interval clamp.

The embedding queue drains batch-claim → batch-read → embed → quantize → one vector commit → per-job settle. Claims are lease-guarded (`lease_owner` / `lease_until`, 60 s default): expired leases are reclaimed, a lease expiring on its final attempt terminalizes `failed`, and completion settles under an unexpired-lease guard. Each successful vector batch advances `embeddingEpoch` exactly once while `indexEpoch` and the reserved runtime `evidenceEpoch` stay frozen. Aggregate provider usage is deterministically allocated across settled jobs without changing its total. The client (`src/embed/client.ts` in [rlh-code-index-local](../../packages/index/code-index-local)) is an OpenAI-compatible fetch adapter: batches of at most `min(batchSize, maxInputsPerRequest)` (default 16) texts per wire request, each armed with caller-signal-plus-deadline (30 s default), replies over 4 MiB refused before parsing, record count/order/dimensionality validated, and every failure mapped onto one of six stable codes — `EMBED_RESPONSE_INVALID`, `EMBED_PROVIDER_ERROR`, `EMBED_INVALID_CREDENTIAL`, `EMBED_DIMENSION_MISMATCH`, `EMBED_ABORTED` (caller cancellation), `EMBED_TIMEOUT` (deadline elapsed). A caller abort stops the drain without settling the in-flight job; a timeout settles it through the attempt budget (partial spend onto `usage_json`) and the drain continues with the next job.

On provider open and after every committed refresh, a generation coverage reconciler enqueues every current chunk missing a vector and schedules one folded drain (detached from the refresh caller, single-flight, bounded by `maxJobsPerDrain` 256 and `maxPromptTokensPerDrain` 200000); drain failures surface through the runtime's internal `vectorStatus()` projection, never through the seam. The vector lane (weight `search.vector_weight`, default 0.9) registers last — lexical → grep → graph → literal → vector — and independently recalls semantic candidates through `VectorReadFacet.recallCandidates` before merging cosine reranks of the earlier lanes' candidate pool (capped at `search.vector_max_candidates` = 2000) with `cosineQuantized`, reporting at most `max(search.vector_top_k, the tier's base top-K)`; without an embedding config or a query vector it disables itself, and a stored-dimension mismatch aborts the lane into `readErrors` instead of ranking noise. Degradation stays three-layered: watcher loss and whole-lane aborts pin the sticky `status().degraded` until a clean operation proves otherwise, while per-read failures such as an unreachable query embedder degrade only that answer. Generation identity covers provider, credential-free endpoint, model, dimension mode, normalization, quantizer, and chunker; jobs and vectors key on it, so enabling or switching generations backfills unchanged chunks without mixing same-model endpoints. Query embeddings memoize in a 32-entry LRU, and the graph result cache fingerprints the query vector plus all clocks, so an embedding batch invalidates pre-vector answers without moving runtime evidence.

### cycles and dead_code explores

`exploreGraph` gains two analysis ops, both pure answer assembly over the existing tables. `cycles` runs an iterative Tarjan SCC pass over the file-import graph: only components of size > 1 count (a self-import never surfaces), components order largest-first before the `max` cap so truncation keeps the largest cycles, severity is `high` at ≥ 5 members and `medium` at ≥ 3, and each component carries its witness edges — stored import rows whose both endpoints are members. `dead_code` finds symbols with no incoming callers and no external references through a bounded scan of at most `min(40 × cap, 5000)` rows, phase-1 filters (empty identity, entry-point names such as `main` / `__init__` / `setup` / `configure`, test-ish `test_*` / `Test*` prefixes) and phase-2 external-reference elimination; every survivor reports `reason: 'no-callers'` and the default item cap is 50. Both ops project their edges — cycles' witnesses, dead-code's declared `CALLS` / `REFERENCES` reverse lookups — and the tool's `op` enum now covers all five questions.

### Spec-driven languages and SFC extraction

The tier matrix covers twenty supported language names — nineteen distinct languages, since `jsx` shares the JavaScript grammar — in four assignments: `semantic` (0.85) for the JS/TS family, Python, and Rust; `tree-sitter` (0.7) for Go, Java, and C/C++; the two SFC names `vue` / `svelte` at `heuristic` with a pinned 0.78 (the reference `parse_sfc`'s confidence — a named deviation from the heuristic default 0.5); and eight regex-driven languages — C#, PHP, Ruby, Swift, Kotlin, Dart, Scala, Lua — at `heuristic` 0.5. The spec-driven extractor ports the reference's `spec_driven.rs` tables (symbols, imports, same-file call edges, a call-keyword blocklist) with no grammar at all; its C# `GetEnvironmentVariable` data-flow edges and resolution-tier edge fields stay out of this record vocabulary. SFC extraction reuses the JS/TS grammars over each component's `<script>` blocks, so components parse without a dedicated wasm; the `event_emitter` dispatch kind is reserved for SFC template-event edges that no walker emits yet.

### The code-context recall contributor

[rlh-code-context](../../packages/context/code-context), a `context` group package outside the index wiring, is the seam's first context-side consumer: an opt-in step-context contributor that joins each step's direct user text into one query — distinct `@file` mentions ride along as the explicit `paths` scope — runs one ranked search, then batch-hydrates the selected candidates. A healthy answer contributes one untrusted `## Code-index recall` message containing source-verified fenced snippets (entry budgets applied in ranked order: `maxChars` 65536, `maxHits` 8, `minQueryChars` 8) plus one evidence record per admitted snippet whose `revision` is the backing file's content hash and whose digest covers the exact injected source; stale or unavailable hydration is omitted with a warning and coverage record. A no-hit step gets a short bounded-negative message instead of silence, while degraded search or total hydration failure contributes nothing beyond a structured warning. Anti-recursion is structural: the query reads direct user messages only, so injected recall text never feeds the next query, and the `form: 'recall'` source record stays out of the session-query corpus extraction. A Loader entry without a config section constructs `ctx.codeContext` but registers no contributor, and the package ships in no bundle.

## Invalidation and refresh

Three trigger entries fold into the same single in-flight pass: an explicit `refresh()` call, the tool-result invalidator (a debounced full stale pass, 500 ms default), and the opt-in recursive watcher, which retains and unions native event paths into `RefreshOptions.paths`; `.gitignore` events widen to a full pass. Every query also lazily guarantees a fresh-enough medium (`reason: 'lazy'`) instead of surfacing `CODE_INDEX_NOT_INDEXED`. The watcher is a latency optimization only — correctness comes from the walk itself — so when it cannot bind, the provider degrades to touch-driven invalidation and reports it through `status().degraded`; watcher events may also lag a pass by up to one debounce window. Summaries and epochs publish only after the pass commits. `BuildExplain` records full/scoped and ran/skipped decisions, dirty closure/budget state, degradation reasons, generation backfill, failed-job resets, and asynchronously completed embedding batch/job counts. A no-delta pass skips its write transaction and leaves `indexEpoch` unchanged.

## Tool surface

[rlh-tool-code-index](../../packages/index/tool-code-index) is a function plugin whose four tools map snake_case arguments onto the seam request (`path_prefix` → `pathPrefix`, `recent_paths` → `recentPaths`, `top_k` → `topK`; `explore_code_graph` maps `file_path` / `include_tests` onto the graph-explore union); `include_grep: false` forwards an advisory grep-lane hint providers may ignore. Cross-op illegal combinations on the explore tool (for example `op=tests` without `files`) are ordinary argument errors raised in `execute`. `code_index_status` takes no arguments; `refresh_code_index` takes `force?` to rebuild from scratch. A second tool-driven refresh pass while one is awaited answers `INDEX_TOOL_REFRESH_IN_PROGRESS` immediately instead of queueing behind the fold; a provider throw without a stable code becomes `INDEX_TOOL_FAILED` with the original as `cause`, and stable provider codes such as `CODE_INDEX_NOT_INDEXED` propagate unchanged.

Output budgeting applies at one exit boundary, ported from the reference `ExitPolicy` design: `search_code_index` byte-caps its complete serialized answer, while status and refresh are passthrough because their shapes are naturally bounded. The cap reads the answer's own tier (`repoSizeTierMaxOutputChars`: 18000/24000/32000/38000) after execution and measures UTF-8 bytes; a 256-byte reserve keeps the envelope's own keys under the original budget. An over-budget response returns the truncation envelope `{ _truncated, _original_chars, _max_chars, partial }` as the canonical value, rendered as recovery prose that never unfolds `partial` back into context. With `clampTopKToTier: true` the model-facing `top_k` lever disappears so the engine's tier cap always decides hit count.

The plugin ships one fixed system-prompt section (`tool:code-index`, order 107, between filesystem discovery and shell tools) telling the model to prefer the index for symbol/chunk questions, reach for `explore_code_graph` once symbols are known (callers/callees walks, blast-radius sweeps with impacted tests, file-to-test mapping), keep grep/glob for exact literals and exhaustive occurrence checks, and confirm epochs via `code_index_status` / `refresh_code_index` before blaming the index for a miss.

## Model-facing behavior

Hits render one line each as `path:start-end score reasons` under a tier-labeled header, `[degraded]` notes appear whenever `readErrors` is non-empty, and a candidate-count footer appears exactly when the engine truncated ranking. Explore answers render the same way: a tier-labeled op header, `role kind name @ file:start` per node, the enrichment's `caller: X → Y (f:line)` template per edge, `test: spec → code (reason)` per pair, and an explain summary whose truncation footer appears only when a cap clipped the answer. Results are deterministic for an unchanged epoch pair, self-explaining through `reasons` tokens, and bounded twice — engine top-K keeps hit counts small while the exit cap bounds the complete answer. All four tools are append-only at the KV-cache level: tool results follow the reusable request prefix and never invalidate existing entries.


### Retrieval evaluation gate

`evaluateRetrieval` executes judgments through the public seam. Committed TypeScript, Python, and Go fixture repositories plus the checked-out package and scoped incremental samples feed executable Recall@5, MRR, and incremental-p95 thresholds. This is a repeatable CI gate; broader external-repository relevance corpora can extend the same format.

## Known limitations

- **Graph explores stop at depth 2** — `relations` accepts `depth` 1–2; deeper traversals are deferred until a consumer needs them.
- **No parse-timeout API** — web-tree-sitter exposes no interrupt hook, so a pathological file relies on per-file isolation and error-tolerant traversal instead of a time bound.
- **Heuristic tiers are regex heuristics** — the eight spec-driven languages and the SFC `<script>` reuse carry the reference's blocklists and confidence pins but no grammar; its C# `GetEnvironmentVariable` data-flow edges and resolution-tier edge fields (callee uid, resolution kind/strategy) are not in this record vocabulary, and no walker emits the reserved `event_emitter` dispatch kind yet.
- **Literal indexing is JS/TS-classified only** — the nine-kind classifier gates which literals are recorded at all, Python and Rust emit no literal rows, and the classifier's config-key `key_path` is still trimmed from the stored record surface.
- **Cycle analysis is file-granular** — the reference's package/community projections (and their `critical` severity class) stay there; components order largest-first and severity stops at `high`.
- **Embed cost governance is per-drain** — the budgets are `maxJobsPerDrain` / `maxPromptTokensPerDrain` plus per-job `usage_json`; there is no cross-run or wall-clock spend ceiling, so a deployment wanting one must own it above the provider.
- **Pending embed jobs wait for a drain trigger** — the queue is durable, but a drain only starts folded into a committed refresh; jobs whose process exits before draining stay pending until the next refresh pass.
- **The code-index tier is not in the Python distribution** — no shipped agent preset mounts an `rlh-tool-code-index*` plugin and `python/sdk-runtime/package.json` carries no matching dependency, so `verify-runtime-closure` correctly does not require it; shipping the tier there means adding the preset line and the full seven-package runtime dependency chain together.
- **Storage is synchronous** — `DatabaseSync` blocks the JavaScript thread per statement; a mismatched store rebuilds in place, discarding acknowledged state without prompting. The `'zstd'` encoding stores compressed frames as base64 TEXT, so the stored form can exceed the plain bytes for marginally compressible payloads just over the threshold.
- **Indexing breadth and concurrency are bounded** — include/hard-exclude tables stay fixed; nested `.gitignore` applies; stat/hash/read-parse stages use deterministic 16/8/4 concurrency. Unsafe watcher events still widen to a full tree.
- **The watcher is not a correctness source** — it optimizes latency, degrades silently-by-design to touch-driven invalidation, and its events may lag a pass by up to one debounce window.
- **One local runtime/store serves one workspace by construction** — Web routes Session cwd through the workspace router and never shares a runtime or database across canonical roots. The explicit single-workspace adapter rejects a mismatched root; only an operator deliberately reusing one explicit `databasePath` outside the router can violate this boundary.
- **The refresh busy guard is process-local** — deployments mount the tool Consumer once.
- **`RefreshSummary` carries aggregate counts only**, by design, to keep every exit bounded.
- **Compaction checkpoints can re-index recall-derived text** — a checkpoint rides the log as a `user/message` under a plugin source, so the session-query corpus extraction (which skips only `form: 'recall'` messages) indexes its summary like an assistant reply, and that summary may restate recall-derived text. ADR 0006's rule-6 anti-recursion boundary stops at system-injected context; a model-authored checkpoint summary sits on the assistant-reply side of it.
- **`dead_code` ignores the `files.is_test_file` column** — test-file exclusion runs on name prefixes only (`test_*` / `Test*`), and the tool accepts `max` up to 10000 with the scan bounded at `min(40 × max, 5000)` rows; both details transcribe the reference implementation verbatim.


### Code Index Center product surface

`managementStatus()` projects file/chunk counts, epochs, BuildExplain, embedding generations, coverage, backlog, failed jobs, and bounded errors. The typed Host Remote exposes refresh, reconcile, confirmation-gated rebuild, and compact search debug (500 query characters, 20 paths, top-K 20; no hydration). Web Settings renders those facts and requires typing `REBUILD`; the Host independently verifies the token. The default Web composition includes the workspace router and code-context contributor, and Desktop reuses the same Web UI. Every Remote request carries a `sessionId`; the Host resolves its attached Session cwd and binds the matching isolated index. The Client cache is Session-keyed and follows Session switches.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcodecontext--codecontext"></a>

### `ctx.codeContext` — `CodeContext`

Owner of the code-index recall contributor (`ctx.codeContext`). The service itself carries no query surface: it exists so a deployment can observe that recall injection is active and dispose it as one unit. Registration is strictly opt-in — a Loader entry without a `config` section constructs the service but registers no contributor.

Source: [`packages/context/code-context/src/index.ts:52`](../../packages/context/code-context/src/index.ts)

<a id="ctxcodeindex--codeindex-abstract-seam"></a>

### `ctx.codeIndex` — `CodeIndex` (abstract seam)

Service Definition for the local code-index capability (`ctx.codeIndex`).

```ts cordis-catalog
/**
 * Report index health without side effects.
 * @returns current file count, resolved tier, epoch pair, last refresh summary, and degraded flag.
 */
abstract status(): Promise<IndexStatusReport>

/**
 * Operator-oriented health projection; providers may enrich the basic status.
 * @returns bounded file/chunk/generation/build health for management clients.
 */
async managementStatus(): Promise<import('./types.ts').CodeIndexManagementStatus>

/**
 * Reconcile provider-derived work without requiring a destructive rebuild.
 * @returns settled management status after reconciliation.
 */
async reconcile(): Promise<import('./types.ts').CodeIndexManagementStatus>

/**
 * Bring the derived index up to date with the workspace tree (or rebuild it).
 * Concurrent calls fold into the single in-flight pass; refresh summaries are emitted only
 * after that pass commits, never speculatively.
 * @param options - trigger reason, forced full rebuild, or explicit path subset.
 * @returns what changed and the epoch pair after the final commit.
 */
abstract refresh(options?: RefreshOptions): Promise<RefreshSummary>

/**
 * Run deterministic hybrid retrieval over the indexed chunks.
 * @param request - query plus optional scope, recency, prefix filter, and requested size.
 * @param signal - cancellation for the active step.
 * @returns ranked hits with epoch pairing; `degraded=true` when a lane failed partially.
 */
abstract search(request: SearchRequest, signal?: AbortSignal): Promise<SearchResult>

/**
 * Resolve full indexed source bodies for an ordered batch of chunk identities.
 * Providers revalidate each backing source against its indexed content hash;
 * stale or unavailable identities are returned only in `rejected`.
 * @param request - ordered chunk identities to hydrate.
 * @param signal - cancellation checked before and after the synchronous store read.
 * @returns resolved bodies, explicit misses, and the generation observed by the read.
 */
abstract hydrateChunks(request: HydrateChunksRequest, signal?: AbortSignal): Promise<HydrateChunksResult>

/**
 * Answer one structured graph question over the derived call graph.
 * @param request - the `relations` / `impact` / `tests` / `cycles` / `dead_code` question
 *   with its per-op options.
 * @param signal - cancellation for the active step.
 * @returns nodes, edges, optional test pairs, cycle components, or dead-code candidates,
 *   plus the explain envelope under the epoch pair they were read at; every rendered
 *   edge's endpoints resolve inside the answer's `nodes`.
 */
abstract exploreGraph(request: GraphExploreRequest, signal?: AbortSignal): Promise<GraphExploreResult>

/**
 * Bind this capability to one caller-owned workspace root. Multi-workspace
 * providers override this method and route every operation to an isolated
 * derived store. The default adapter preserves existing single-workspace
 * providers and test doubles; production filesystem providers should
 * override it to verify that `workspaceRoot` is their configured root.
 * @param workspaceRoot - absolute workspace root selected by the caller's durable Session.
 * @returns a workspace-bound operation face which cannot be retargeted after construction.
 */
forWorkspace(workspaceRoot: string): Promise<CodeIndexWorkspace>
```

Source: [`packages/index/code-index/src/index.ts:49`](../../packages/index/code-index/src/index.ts)
<!-- END GENERATED cordis-surface -->
