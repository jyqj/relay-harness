# Agent Note: Code-index Phase 2 completion — AST parsing, symbol graph, and explore_code_graph

Status: implemented

English | [中文](2026-08-28-code-index-phase2-completion.zh.md)

## Problem

Phase 1 shipped the chunk core (scan → diff → chunk → store → retrieve) end to end, but every AST-grade ingredient the capability is ultimately for was still absent: no parser produced symbols, imports, call edges, or literals; the seam's graph vocabulary was compile-face only; `SearchHit` carried no graph contribution; and the model had no way to ask structural questions (who calls this, what breaks if this changes, which tests cover this file). Phase 2 had to land the parsing layer, the symbol graph, graph-aware retrieval, and a model-facing graph tool as one coherent delivery without destabilizing the Phase 1 guarantees (deterministic answers, epoch pairing, bounded exits).

## Decision

Phase 2 lands in nine knives, each documented in its own Agent Note; this note records the completion surface and the deliberate deviations from the reference implementation (`codecortex` cc-server/cc-search/cc-db) that span knives.

- **Delivery surface.** The parser package walks ten language names (JS/TS family, Python, Rust at `semantic` 0.85; Go, Java, C/C++ at `tree-sitter` 0.7) over nine official tree-sitter grammar WASMs; the resolver binds unbound call edges through the fixed nine-step ladder (`self_member` … `global_unique`, then the three fuzzy-signal steps) into `resolution_kind` / `resolution_confidence` / `resolution_strategy`; the v2 graph tables store symbols, imports, call edges, refs, path-derived test edges, and verbatim literals under the same epoch-bumped transactions as the chunk core; dirty propagation re-resolves the transitive importer closure of every export-surface change within a per-pass budget; retrieval runs the graph lane and connectivity rerank (`searchWithGraphContext`) with an epoch-keyed result cache; and the seam exposes `exploreGraph` over `relations` / `impact` / `tests`, surfaced as the fourth tool `explore_code_graph`.
- **sha256-derived ids deviate from the reference on purpose.** Symbol uids hash (`file, qualified name`) so line drift keeps an id stable and a signature change moves it; the reference derives ids from source positions, which made every reformat churn the graph. Ref and edge ids hash their site coordinates (file, name, line, col) for the same determinism reason.
- **Grammar supply switched to official release artifacts.** `tree-sitter-wasms@0.1.13` (the reference's source) ships legacy `dylink.0` sections that web-tree-sitter ≥ 0.25 refuses to load; `resources/grammars/VERSION` pins the upstream release URL and exact byte size of each of the nine WASMs instead.
- **No parse-timeout API exists.** The reference bounds parse time through tree-sitter's interrupt hook; web-tree-sitter exposes none. The substitute is structural: per-file isolation (a pathological file becomes one `parseErrors` entry, never a stuck pass) plus error-tolerant traversal of malformed trees.
- **Port and cache differences from the reference, summarized:** the retrieval port projects edge rows by seed side without the stored `resolution_strategy` / `resolution_confidence` columns (explore derives confidence from the resolution kind and omits the strategy field); `findImpactedTests` returns raw association rows, so deduplication and ordering live caller-side; the graph result cache (32 LRU entries) keys on epochs + request + limits + ranking fingerprint and never caches degraded outcomes, where the reference's cache spans the runtime; and the local provider always takes the graph path, since an empty graph degenerates to the plain pipeline rather than needing an availability probe.
- **Faithful projection over silent repair.** Explore answers include the declaration self-loop edges the JS/TS regex fallback lane produces, and test pairs only exist after an incremental pass rebuilds them (a full build writes none) — both are store-level facts the read side presents rather than papers over.

## Alternatives considered

- **Deriving explore edges from the enrichment's node views** — rejected: enrichment is a search-side budget consumer; explore needs seed-side walks with their own caps, so the provider assembles answers straight from the graph read facet (`src/explore.ts`).
- **Hiding unresolved-call edges and declaration self-loops from explore answers** — rejected for this phase: the read side must not second-guess the parser; filtering belongs where the extraction decision is made.

## Consequences

The capability now answers structural questions end to end: search boosts graph-connected chunks and explains the boost, `explore_code_graph` walks callers/callees, sweeps impact with tests, and maps files to their tests over the real store, and every answer stays epoch-keyed, bounded, and self-explaining. The REAL-composition suite measures a 9-file fixture's first full index at a median 5 ms (~0.56 ms/file). Two known gaps remain open on purpose: real repositories currently trip parser write-side UNIQUE constraints (duplicate extraction records at identical positions, e.g. literal rows on one line and overload pairs), which caps certified corpus size until the parser dedupes; and explore's declared strategy field stays unset until the port's edge projection carries `resolution_strategy`.
