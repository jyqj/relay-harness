# Agent Note: Local code-index seam scaffold — retrieval vocabulary before providers

Status: implemented

English | [中文](2026-08-27-local-code-index-seam.zh.md)

## Problem

The local code-index capability needs a Service Definition before any provider exists, so the SQLite store, ranking engine, local provider, and tool consumer can land without schema churn. The capability is one increment of a three-phase plan (lexical/grep hybrid retrieval → AST symbol graph → embedding vectors + contextEngine evidence) that ports CodeCortex's retrieval design natively instead of via MCP. Without the seam first, each later package would invent its own wire types and epoch/cache semantics.

## Decision

Open the `packages/index/` group with `@relay-harness/rlh-code-index`: `ctx.codeIndex.status()` / `.refresh()` / `.search()`. Key contract points:

- `EpochPair` (`indexEpoch` advanced exactly once per committed content write; `evidenceEpoch` reserved for semantic-evidence ingestion) is part of the first interface; consumers key caches on both.
- `RepoSizeTier` constants live only in `src/tiers.ts`, ported verbatim from the reference implementation (tier bounds 500/5000/25000; top-K 5/10/15/20; output chars 18000/24000/32000/38000).
- Search results are deterministic (score desc, chunk id asc tie-break), self-explaining (`reasons` tokens), and carry a `degraded` flag whose non-empty `readErrors` mark results as unfit for caching.

Seam Config is deliberately deferred to the provider package — knobs without a current consumer violate the no-unused-surface rule (knip enforces this in practice), and tier tables for explore/graph/token budgets join when their consuming phases land.

## Consequences

Catalog wiring has a six-point registration checklist per new service seam: `SERVICE_PAGE`, `LINK_MAP` ([gen-cordis-catalog](../../../../scripts/gen-cordis-catalog.ts)), `SERVICE_ROLES` plus its group order ([gen-doc-graphs](../../../../scripts/gen-doc-graphs.ts)), the type-equiv manifest, the Model Experience audited-sentence list, and the subsystem-folder README index. An abstract service class must be defined directly in the package entry (`src/index.ts`) for the config-catalog classifier to recognize it; defining it in a sibling module demotes the package to "library".

## Alternatives considered

- **Define the class in `service.ts` behind an entry re-export** — rejected: the config catalog classified the package as "library" because its entry no longer default-exported the abstract service; coverage also duplicated the declaration across files.
- **Ship Config on the seam now** — rejected: every knob (watcher, ignore lists, db path derivation) has its only consumer in the not-yet-written provider, so load-time fail-loud validation would guard nothing real.
