# @relay-harness/rlh-code-index-local

English | [中文](README.zh.md)

Local filesystem Service Provider for the Relay Harness code-index capability: it fills `ctx.codeIndex` for one workspace by assembling the layers that stay deliberately absent elsewhere — tree scanning, incremental diffing, the parser-tier and generic chunkers behind a five-stage pass, dirty propagation, the embedding tier (client, job-queue composition, drain worker), and storage/retrieval assembly over the derived SQLite store.

This package is part of the code-index capability:

| Package | Role |
|---|---|
| `@relay-harness/rlh-code-index` | Service Definition: abstract service, vocabulary types, repository-size tiers |
| `@relay-harness/rlh-code-index-local` (this) | Service Provider: five-stage scan/diff/parse/resolve/write/dirty pipeline wired behind `ctx.codeIndex` |
| `@relay-harness/rlh-code-index-sqlite` | Storage repository: schema, epoch-bumped writes, retrieval port adapter |
| `@relay-harness/rlh-code-index-search` | Retrieval domain engine: preselection, lanes, fusion, rerank |
| `@relay-harness/rlh-tool-code-index` | Consumer: model-facing search/explore/status/refresh tools |

## Pipeline

One pass (`runRefreshPass`) walks the workspace breadth-first, classifies every file against the committed generation with the mtime+size fast path, and re-reads suspicious candidates once for hash confirmation (suppressing touch false positives and mtime jitter). With the runtime's resolver and graph facet supplied, the pass runs five stages: each changed file parses through `parseFile` (unsupported or oversized files fall back to the generic tier — line windows of at most 80 lines, `generic` parser tier, confidence 0.5; undecodable payloads skip as binary), the fresh call edges resolve against the long-lived symbol catalog before writing, one delta commits with per-file export fingerprints, the test-edge rebuild decision runs, and the dirty-propagation phase re-resolves the transitive importers of every export-surface change or removal. Each stage's writes land in its own epoch-bumped transaction, so a pass's epoch advance counts its commits exactly; a full build carries no dirty phase. Without the resolver the pass degrades to the generic-only delta of earlier phases. Exclusion stacks three independent layers — built-in hard excludes plus include globs transcribed verbatim from the reference implementation's `IndexingConfig` defaults, the parsed root `.gitignore`, and explicit `exclude` patterns — and prunes directories before descending; symlinks never expand traversal.

Concurrency folds at the runtime boundary: concurrent `refresh` callers share the single in-flight pass and receive its committed summary. Every query — search or graph explore — lazily guarantees a fresh-enough medium (`reason: 'lazy'`) instead of surfacing `CODE_INDEX_NOT_INDEXED`; epochs ride from the store ledger into each answer. `exploreGraph` answers the `relations` / `impact` / `tests` questions straight from the graph read facet (`src/explore.ts`): callers and callees of a resolved symbol walk through the port's seed-side reads at the tier's per-seed windows, `max` caps the RENDERED nodes globally (targets first, then edge endpoints; the first refused add stops rendering and records `max_nodes`), test pairs ride the path-derived `test_edges` capped at the tier's `maxTests` (`result_limit` when cut), and a symbol that resolves to nothing comes back as an empty answer with a `symbol_not_found: <name>` entry in `explain.readErrors` — a degradation, not a truncation. The analysis ops live beside it: `cycles` (`src/cycles.ts`) runs an iterative Tarjan SCC pass over the full store import adjacency, keeps only components larger than one file, orders them by size descending before the `max` cap cuts, grades severity by member count, and attaches each component's witness import edges; `dead_code` (`src/dead-code.ts`) scans a bounded `min(40 × max, 5000)`-symbol superset whose reverse call/reference lookups the store computes per row, then drops entry-point names (`main`, `__init__`, `__main__`, `setup`, `configure`), test-ish name prefixes (`test_`, `Test`), and every symbol with a caller or an external reference, reporting the survivors with `reason: 'no-callers'`. Searches run the graph package's `searchWithGraphContext` over the composed graph defaults and the tier's enrichment limits and token budget, so a connected chunk can out-rank its base score; with an empty graph the enrichment resolves nothing and the answer equals the plain pipeline. The graph result cache is bound to the retrieval stack and dropped when a tier resize rebuilds it. Tool results invalidate through a debounced stale pass (default 500 ms), and an opt-in recursive watcher collapses native event storms into the same folded pipeline — a latency optimization only, since correctness comes from the walk itself. When the watch cannot bind, the provider degrades to touch-driven invalidation and reports it through `status().degraded`.

The store path defaults to `<rlhHome>/index/code-index-<hash>.sqlite3` where `<hash>` is the first twelve SHA-256 hex characters of the workspace real path; `$RLH_HOME` or an explicit `databasePath` overrides it.

When an embedding tier is configured, every committed pass enqueues its changed chunk rows (chunk ids joined with their files' content hashes) through the storage queue and starts one folded queue drain, detached from the refresh caller. Searches embed the trimmed query text (memoized in a 32-entry LRU keyed by model, dimensionality, and text hash) into the engine request, where the vector lane re-scores the candidate pool the other lanes built with quantized cosine over `chunks_vec`. The graph result cache keys the query vector by its content fingerprint, so vectors landing under a moved evidence clock recompute instead of serving stale answers. A failed query embedding degrades that one answer (recorded in `readErrors`, no fabricated vector contribution) without pinning `status().degraded`; only whole-lane aborts (`<laneId> lane failed`, such as a stored dimension contradicting the embedder) are sticky. Drain and enqueue failures never fail the committed refresh; they surface through the runtime's internal `vectorStatus()` projection (model, backlog, coverage, last drain error) — the seam status report stays untouched.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `workspaceRoot` | process working directory | Workspace scanned by every pass |
| `databasePath` | derived under `<rlhHome>/index/` | Dedicated SQLite file, or `:memory:` |
| `journalMode` | `wal` | SQLite journal pragma forwarded to the opener |
| `exclude` | `[]` | Extra `.gitignore`-syntax excludes stacked over hard excludes |
| `maxFileBytes` | `512000` | Byte ceiling before a file records its row without chunks |
| `debounceMs` | `500` | Tool-result invalidation debounce |
| `watcherEnabled` | `false` | Opt-in recursive filesystem watcher |
| `dirtyPropagationMaxFiles` | `200` | Global per-pass budget on files promoted by dirty propagation |
| `embedding` | — | Embedding tier; omitting `baseURL` or `model` (or the section) removes the vector lane, the drain, and vector status as a whole |

Misconfiguration fails loud at load: the workspace root must be an existing directory and numeric knobs must be positive safe integers.

`embedding` accepts `apiKeyEnv` (credential-ref naming the environment variable that carries the bearer key, default `EMBEDDING_API_KEY`), `baseURL`, `model`, `dimensions` (omit to lock onto the first reply), `batchSize` (`32`), `timeoutMs` (`30000`), `maxInputsPerRequest` (`16`), `maxPromptTokensPerDrain` (`200000`), `maxJobsPerDrain` (`256`), `vectorWeight` (`0.9`; `0` mutes the lane), `vectorTopK` (`12`), and `vectorMaxCandidates` (`2000`). A configured tier that cannot reach its endpoint degrades per operation; a blank credential fails loud on every attempt through `EMBED_INVALID_CREDENTIAL`.

## Embedding Tier

`src/embed/` owns the path from chunk text to a stored int8 vector. `EmbeddingClient` speaks the OpenAI-compatible `POST /embeddings` shape to one `(baseURL, apiKey, model)` endpoint: it splits input into wire requests of `min(batchSize, maxInputsPerRequest)` texts, arms each with a caller-signal-plus-deadline, validates record count, order, and dimensionality (the configured `dimensions`, or the first reply's, locks the client for its lifetime), and accumulates `usage.prompt_tokens`. Failures carry stable codes — `EMBED_PROVIDER_ERROR` (HTTP errors, transport), `EMBED_ABORTED` (caller cancellation), `EMBED_TIMEOUT` (a wire request's deadline elapsed), `EMBED_RESPONSE_INVALID` (non-JSON, over the 4 MiB read ceiling, count mismatch), `EMBED_DIMENSION_MISMATCH`, `EMBED_INVALID_CREDENTIAL` — so the drain routes instead of parsing messages; a failure after earlier wire batches of the same call were billed carries their spend on `error.promptTokensUsed`.

`drainEmbedJobs` composes the storage package's `code_embed_jobs` queue with the client and the search package's int8 quantizer: per claimed job it reads the chunk text, embeds, quantizes, commits the `chunks_vec` row inside one evidence-epoch transaction (one clock advance per job), and settles the job with its recorded usage. The token budget is checked before each claim, so the drain never starts work it could not pay for. A caller abort stops the drain without settling the in-flight job (its lease expires to a later claim); a per-batch deadline (`EMBED_TIMEOUT`) settles the job through the attempt budget — partial spend rides onto `usage_json` — and the drain moves to the next job; a deterministic failure (`EMBED_DIMENSION_MISMATCH`, `EMBED_INVALID_CREDENTIAL`) settles the job and stops the drain loudly instead of burning the queue-wide attempt budget. The quantizer is injectable and defaults to `quantizeInt8`. The provider wires this tier into retrieval only when configured: the vector lane registers last (after literal) in the composed defaults, re-scoring the deduplicated candidate pool earlier lanes built (capped at `vectorMaxCandidates`) against the memoized query embedding, and `EmbeddingClient` / `embedQueryVector` / `drainEmbedJobs` accept structural embedder surfaces so deployments can compose other embedders.

## Model Experience

Indirectly, through the `search_code_index`, `explore_code_graph`, `code_index_status`, and `refresh_code_index` tools whose seam answers this provider produces: ranked file/line hits and graph explore answers are read out of the chunks, symbols, and edges assembled here.

#### KV Cache effect

No direct request-prefix changes; cached conversations stay valid because index epochs advance monotonically and consumers key reuse on the pair.

## Known Limitations and Deferred Work

- **First full-index cost on this machine's fixture** — the REAL-composition suite measures a 9-file fixture at a median 5 ms per full pass (about 0.56 ms/file across three passes); larger corpora have never been certified because real repositories currently trip parser write-side UNIQUE constraints.
- **Explore projects stored edges faithfully, warts included** — every function carries a self-loop call edge at its declaration line (the parser's regex fallback lane reads the `name()` parameter list as a call site), and `explore_code_graph` answers include it; filtering is a parser-side concern, not a read-side one.
- **Storage-root derivation is interim** — the workspace-hash filename avoids multi-checkout clobbering but is not the planned configurable storage-root layout; expect a migration when it lands.
- **Watcher degradation is silent-by-design** — refusal downgrades to touch-driven invalidation and one `status()` flag; events may also lag passes up to one debounce window.
- **Nested `.gitignore` files are unread** — only the workspace root's document applies.
- **One store serves one workspace** — separate deployments pointing two workspaces at the same explicit `databasePath` interleave generations.
- **Embedding cost governance is per-drain, not per-month** — spend visibility is the `usage_json` recorded on each completed job plus the drain's `maxJobs`/`maxPromptTokens` budgets and `pendingEmbedCount` backlog gauge; there is no monthly or cumulative budget accounting, and none is planned until a consumer needs it.
