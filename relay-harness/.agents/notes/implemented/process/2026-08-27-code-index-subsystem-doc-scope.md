# Agent Note: The code-index subsystem page owns the whole five-package capability

Status: implemented

English | [中文](2026-08-27-code-index-subsystem-doc-scope.zh.md)

## Problem

`docs/subsystems/code-index.md` still documented the scaffold state: the seam package only, with prose stating that provider, store, engine, and tool packages "land in subsequent increments". All five packages have since shipped, so the reference page no longer matched the subsystem it owns, and the era left stale claims in package READMEs — `rlh-tool-code-index`'s Known Limitations asserted "No shipped provider exists yet" while `rlh-code-index-local` is exactly that provider. A reader routing through the subsystem page had no single place describing the pipeline that crosses all five packages.

## Decision

`docs/subsystems/code-index.md` (and its Chinese counterpart) is now the whole-capability reference: the package-role table with each package's wiring, the data flow from scan through the exit envelope, epochs, the repository-size tier table (including the store's cache-capacity column), the retrieval pipeline with its lane/fusion/rerank constants, the six-table storage layout and its FTS maintenance discipline, the provider pipeline (exclusion layers, diff, chunking, store-path derivation), the three invalidation triggers, the tool surface with its exit budget and truncation envelope, model-facing behavior, and one consolidated Known Limitations section. The subsystems README index lines describe the page's new scope. The stale README claims are fixed at their owners: `rlh-code-index`'s intro now states all three roles ship, and `rlh-tool-code-index`'s "no shipped provider" limitation is removed. The registered `SearchRequest` type-equiv block and the generated cordis-surface region are untouched.

## Alternatives considered

- **Rely on the five package READMEs alone** — rejected: each README is a per-package contract, so the cross-package pipeline (one pass, one epoch advance, one exit cap) had no home, and the subsystem tier exists precisely to carry one page per subsystem.
- **Update the landing notes instead** — rejected: the five `2026-08-27-code-index-*` notes record landing decisions, not the documentation scope of the subsystem tier; rewriting them would turn decision records into reference prose.

## Consequences

The page is now the entry point for every code-index fact that spans packages, and future increments (P2 symbol/graph, P3 vector/evidence) extend its consolidated limitations section rather than leaving scaffold-era prose behind. Bilingual pairing records for the four edited pairs are re-recorded, and the type-equiv gate still passes against the unchanged block.
