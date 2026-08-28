# Agent Note: Code-index SQLite writes and reads — epoch-exact transactions feeding the retrieval port

Status: implemented

English | [中文](2026-08-27-code-index-sqlite-writes-reads.zh.md)

## Problem

The storage slice ([SQLite store](2026-08-27-code-index-sqlite-store.md)) admitted databases but exported no write or query path, so every consumer above it — the provider increment, the ranking engine's `RetrievalPort` — was blocked on three decisions this layer had to make correctly on day one: when exactly the cache-invalidation clock advances, in what order app-maintained FTS mirrors are touched relative to their base rows, and where scan budgets live between store and search. Getting any of these wrong fails silently: a missed bump serves stale chunks, a reordered mirror delete leaves FTS rows pointing at reused rowids, and a budget enforced store-side can never be shared with the lane that owns the user-visible "truncated" answer.

## Decision

Port the reference implementation's write/retrieval model into `packages/index/code-index-sqlite` as four modules, adapting to this schema (six tables, no symbol tier yet, language on the file row):

- **Epochs fold into their transactions** (`src/epoch.ts`). `bumpIndexEpochOnceInTx` wraps `BEGIN IMMEDIATE … COMMIT`, runs the caller's statements inside it, advances `index_epoch` as the last statement before COMMIT, and rolls back everything — counter included — on failure. Evidence stays frozen per `epoch_rules.rs`; P3 flips its channel without touching this wrapper. `assertExactAdvance` audits commits against the declared channel; `readEpochs` refuses missing or unparsable ledger rows (`CODE_INDEX_SCHEMA_VERSION_UNSUPPORTED`, the same code the codec reuses for unrecognized media state) instead of silently re-zeroing, because consumers key caches on these values.
- **Writer mirrors follow the base-row lifecycle** (`src/writer.ts`). One delta is one bumped transaction. Mirror deletes run before base deletes through rowid subqueries against the still-present base rows; inserts capture the outermost statement's `lastInsertRowid` (trigger inserts do not disturb it) to re-mirror under aligned rowids; removals batch at the reference's 200-variable budget. Upserts count as replacements, not removals.
- **Reader implements the port verbatim** (`src/reader.ts`), matching `packages/index/code-index-search/src/port.ts`: bm25 with the reference column weights, scope rendered as SQL with escaped LIKE metacharacters, unscoped grep scans streamed in `rowid DESC` order, skipped ids passed over before decode cost, budget policy left entirely to the visitor side. Two schema adaptations: `symbolNamesByTokenSubstring` answers empty (no symbols table), and language joins from `files`.
- **Cache keys embed the clock** (`src/cache.ts`). Slots are `(index_epoch, chunk_rowid)` strings, so no manual invalidation exists to forget; capacity is a package-local tier table (tiny/small/medium/large = 128/256/384/512) recorded in the README as the owning decision. The degraded-results discipline lives in the API shape: `setIfFresh` requires a freshness pair, so a `readErrors`-non-empty call site cannot write even by accident.

## Consequences

What landed: exactly-once epoch semantics verified across batch sizes and reopen; atomic rollback with zero residue and zero counter drift; English and Chinese FTS MATCH coverage through mirrored plain text; port parity exercised through the real search engine end-to-end (lexical + two-stage grep + scoped paths). Tests import the search package as a devDependency only — runtime code references it through `import type`, so the published package grows no peer edge and no cycle. Package-scoped oxlint, export-JSDoc, vitest-with-coverage (per-file 100%), and slice typecheck all pass; repo-wide build/lint currently fail only inside sibling in-flight packages (see the [store note](2026-08-27-code-index-sqlite-store.md) for the same caveat). Deferred with rationale: compressed encodings (codec contract already rejects them), evidence-channel writes (P3), symbol-tier retrieval methods (P2).

## Alternatives considered

- **Version-tagged entries with a sweep on commit** — rejected: sweeping cached slots at every bump reintroduces exactly the bookkeeping the clock exists to avoid, and a missed sweep is the silent-stale bug class this design makes unreachable.
- **Budget accounting inside the reader** — rejected: the port assigns scanning costs to the store but truncation policy to the engine, which merges two stages and owns the user-visible `truncated` flag; duplicating either half in storage would let them disagree.
- **Normalized FTS sync via triggers like `file_paths_fts`** — rejected for `chunks_fts`: per-chunk AFTER INSERT triggers would run inside every write path anyway while hiding the mirror contract; explicit statements keep the alignment rule visible and testable next to the writer that owns it.
