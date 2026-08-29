# Agent Note: Dirty propagation and the five-stage local index pipeline

Status: implemented

English | [中文](2026-08-28-dirty-propagation-five-stage-pipeline.zh.md)

## Problem

The local provider ran a four-phase, generic-only pass (scan/diff/read/write): no file ever carried parser-tier rows, call edges stayed unresolved forever, and an edit to an exporter left every importer's stored `target_symbol_id` pointing at stale symbols with no repair path. The graph package owned the resolver and the dirty-reresolve write face, but nothing orchestrated them; the Go/Java/C/C++ extractors existed in the parser yet never entered `parseFile`'s dispatch.

## Decision

The incremental pass becomes five stages — scan/diff/read, parse, resolve, write (+ test-edge maintenance), dirty propagation — wired in `runRefreshPass` behind an optional resolver/graph pair, so the pipeline stages and the legacy generic-only pass share one code path.

- **Dirty propagation lives in the graph package** (`src/dirty/`), ported from the reference's `dirty_closure.rs` / `dirty_reload_policy.rs` / `indexer_phases/dirty.rs`: `computeExportFingerprint` (export-only, whole-line sort, SHA-256; `null` with no exports), `computeDirtyClosure` (fixpoint with a global strictly-greater-than budget, 16-round cap, and an inner surface re-evaluation fixpoint for same-round sibling re-export chains), the exhaustive reload policy table (`symbols`/`imports` keep, `callEdges`/`symbolRefs` clear), and `runDirtyPropagation` orchestration.
- **Fingerprint comparison is pre-write vs post-write by construction.** The reference compares in-memory parse output against the pre-write DB because its dirty phase runs before the write. Here the write is stage 4 and dirty is stage 5, so the pass captures the pre-write fingerprints from the metadata ledger before committing and the phase reads the fresh values back through the graph facet. The ledger stays the single authority, which also forced the writer to honor `exportFingerprint: null` (clear the entry when an export surface empties) — otherwise a stale fingerprint would re-seed the closure on every later build.
- **Full builds carry no dirty phase** (matching the reference: full builds report no propagation status). Everything parsed in the same pass was resolved against fresh symbols anyway; there is no stale resolution to repair.
- **The resolver catalog is provider-held and long-lived.** Passes evict their batch (rewrites plus removals) before resolving — eviction happens even for all-removals batches, or a dirty re-resolution would rebind against symbols the store no longer holds — and register the batch's fresh parse symbols so a full build can bind cross-file targets that are not yet in the store. The lazy loader reads committed rows only for files the catalog lacks; after a process restart the store itself seeds the catalog.
- **Reader extensions are reload-shaped.** `callEdgesByFilePaths` / `symbolRefsByFilePaths` return complete stored rows (every parsed-fact column the write-back restores), `importerFilesForTargets` is the reverse of `importsByFilePaths`, and `reexportTargetsForFiles` feeds the closure's surface check. The resolver's `resolveEdges` became generic over its row views so the pipeline holds one row vocabulary from parse through resolve to write with no lossy projection.

## Alternatives considered

- **Running dirty before the write, like the reference** — rejected: this pipeline commits one delta including resolved rows, so a pre-write dirty phase would have to predict post-write fingerprints; capturing them pre-write keeps the ordering honest and the phase idempotent.
- **Surfacing dirty counters on the seam's `RefreshSummary`** — rejected for now: the seam package is frozen for the graph-explore knife, and the pass outcome (`RefreshPassOutcome.dirty`) already exposes counts, the promoted-file set, and the closure status to in-package callers.
- **Promoting through an action map of Skip/Update** — rejected: the reference's action vocabulary models its phase split; this pipeline only needs "not reparsed and not removed", which the closure receives as its promotable predicate.

## Consequences

A pass's epoch advance now equals its commit count exactly (delta + test-edge rebuild when the path set shrank + one re-resolution write when the closure promoted), which the e2e audits literally. Config gained `dirtyPropagationMaxFiles` (default 200). The parser dispatches all ten vendored languages, so `parseFile` returns `null` only for oversized and unsupported paths — a behavior change callers relying on the Go/Java/C/C++ `null` fallback will observe as parser-tier rows and real call edges. Known gaps carried over from the reference: CommonJS forwarding and non-JS/TS re-export equivalents still store as plain imports, so those surface changes do not seed the closure.
