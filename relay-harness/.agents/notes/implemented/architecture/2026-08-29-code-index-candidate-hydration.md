# Agent Note: Separate code-index candidates from source-verified hydration

Status: implemented

English | [中文](2026-08-29-code-index-candidate-hydration.zh.md)

## Problem

The code-index search engine already read chunk text to score candidates, but its public `SearchHit` projected only path and line metadata while `code-context` rendered that metadata as if it were usable code evidence. Binding evidence to the global `indexEpoch` could not identify the source revision, and a watcher delay could leave indexed text behind the current file. Putting full source directly on every `SearchHit` would repair the missing content but inflate tool output and graph-cache values for every consumer, including consumers that never admit source.

## Decision

The code-index seam separates candidate discovery from hydration. `search()` returns compact candidates carrying the indexed file `contentHash`, language, actual parser tier/confidence, ordered additive `scoreTrace`, and reason tokens. The provider-neutral request exposes working-set, pinned, overlay, and ordered conversation-query signals; the newest four distinct conversation queries bias lexical/preselect/overlap scoring while grep retains the primary query.

`hydrateChunks()` batch-resolves full stored chunk bodies in first-occurrence request order. The local provider constrains stored paths to the workspace, hashes each distinct current regular file, and returns a body only when that hash matches the indexed revision. Missing rows, invalid or unreadable paths, and revision drift are explicit `unavailable` or `stale` rejections. This operation stays outside search results and graph caches.

The opt-in contributor described by the [language and code-context note](../feature/2026-08-28-code-index-heuristic-languages-and-context-contributor.md) searches once, hydrates the bounded candidate set once, compares the search and hydration content hashes, and injects only source-verified fenced snippets. Evidence revision is the file content hash, its digest covers the exact admitted source substring, and mechanical verification is `verified`; rejected hydration is warning-visible and coverage-visible, never rendered as a path-only fallback.

## Alternatives considered

- **Inline full text on every `SearchHit`** — rejected because source bytes would consume the search result budget, enlarge graph-cache entries, and charge tool consumers that only need locations.
- **Read files directly in `code-context`** — rejected because the consumer would duplicate workspace containment, chunk identity, parser provenance, revision comparison, and provider-specific storage knowledge.
- **Trust indexed text under `indexEpoch`** — rejected because a global generation neither identifies one resource revision nor detects a backing file changed before the watcher refresh completed.
- **Use mtime and size alone for admitted evidence** — rejected because selected candidate batches are small enough to hash, and an exact content revision is required before marking evidence current and verified.

## Consequences

Search candidates remain bounded metadata and caches remain source-free, while context consumers pay filesystem hashing only for chunks they selected. Hydration can return fewer bodies than search returned; consumers must preserve the distinction between an index miss, a stale source, and an unavailable source. The file hash is truncated SHA-256 according to the provider's existing content-identity contract, so changing that identity scheme is a seam-level revision decision. Full Context Trace persistence and UI projection remain outside this decision.
