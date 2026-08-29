# Agent Note: Code-index SQLite store — fail-closed admission with rebuild-in-place derived media

Status: implemented

English | [中文](2026-08-27-code-index-sqlite-store.zh.md)

## Problem

The local code-index capability needs its on-disk medium before any writer exists, so the provider increment can land against a frozen schema instead of inventing storage mid-flight. The hard part is admission policy: the same database path must refuse foreign applications loudly (a misconfigured path must not be silently reformatted), yet never hold an admitted index hostage to schema drift, because every byte in it is reconstructable from the workspace. The reference implementation solves both, but a first port has to decide which side of that tension each failure mode falls on — and encode that decision in stable error codes the future tools can route on.

## Decision

Open `packages/index/code-index-sqlite` as a pure storage repository: no service class, no Config, no plugin entry — only `openCodeIndexDatabase`, the DDL constants, and the chunk-text codec. Three contract points:

- **Fail closed on identity, rebuild in place on content.** A non-zero foreign `application_id`, or user tables under no registered id, throw `CODE_INDEX_DB_FOREIGN_APPLICATION` before any mutating pragma runs. Once the file is admitted as ours, version drift or unknown tables trigger `resetDerivedSchema` (drop everything, reset `user_version`) followed by recreation — the same precedence order as the memory backend's canonical store, but with rebuild replacing migrate because the index is derived.
- **FTS shadow tables are named inventory.** The admission scan lists plain user tables, and each FTS5 virtual table materializes five (`*_data`/`_idx`/`_content`/`_docsize`/`_config`). The known-set check enumerates all of them explicitly; treating shadows as "unknown" would rebuild a healthy database on every open — caught by tests, not review.
- **Codec is encoding-tagged from day one.** Chunk text stores as a `(text_encoding, text)` column pair; `decodeChunkText` throws `CODE_INDEX_SCHEMA_VERSION_UNSUPPORTED` for unregistered tags rather than guessing. The 128-byte compression-eligibility threshold ports now as a pure function so the compressed tier reuses the tested constant.

Epoch metadata (`index_epoch`/`evidence_epoch`, seeded `'0'`) ships as rows because schema and vocabulary are cheap to freeze now and expensive to retrofit once cache keys above the seam depend on them.

## Consequences

What landed: six-table DDL with STRICT sources, cascade-deleting chunks, unicode61 chunk/file-text FTS plus trigger-maintained trigram path FTS; owner-only file creation (`0700`/`0600`) with silent `EEXIST` passthrough; closing handles on every failure path. Nothing writes or reads yet by design — epochs stay `'0'` and FTS rows stay empty until the provider lands, so README Known Limitations names every absent module rather than implying readiness. Full-repo build/lint gates currently fail on the sibling in-flight `code-index-search` package, so this slice validated with the tsc graph, package-scoped oxlint, and coverage-gated vitest runs.

## Alternatives considered

- **Migrate forward like the canonical memory store** — rejected: migrations exist to preserve irreplaceable durable state; preserving index bytes would add version chains with no consumer benefit over a deterministic full rebuild.
- **Fail closed on unknown tables at matched version** — rejected: after a crash mid-`.sqlite-wal` rotation or an interrupted write, leftover fragments should heal, not brick the workspace index.
- **Encode compression inside the payload prefix** — rejected: merging encoding into the text column couples readers to format sniffing; separate columns keep STRICT typing and per-column projection intact.
