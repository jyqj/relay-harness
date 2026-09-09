# Agent Note: Governed Memory Center product closure

Status: implemented

English | [中文](2026-08-29-governed-memory-center.zh.md)

## Problem

Long-term Memory had an append-only governed provider and a shared Context contributor, but users could not inspect candidates, approve or reject extraction, revise active facts, see evidence or expiry, remove a memory, compare supersession, or understand why a memory entered a model request. Recall was product-visible only as hidden model context.

## Decision

The provider-neutral Memory seam now has a paged `list` read over the canonical current-entry view. Unlike recall search it can return every governance state and expired entries without incrementing retrieval accounting. SQLite implements the read over `memory_entries`, preserving the append-only `memory_revisions` authority.

The Web Host mounts `memoryCenter`; every list/search/read requires an attached Session and verifies the Client workspace against its authoritative cwd-or-global scope before binding configured user/agent identity. Governance mutations additionally carry the displayed revision, append `memory/governance-requested`, require a participating Session durability barrier, and recheck that revision before passing the same compare-and-set guard into the provider write. Approve promotes only candidate/disputed memories to active user-stated facts; reject/delete append tombstones; revise preserves prior Evidence while adding the user's exact governance fact. Detail reads expose source Evidence, `validUntil` freshness, explicit supersession links, and why-used occurrences only when an admitted `context/prepared` contribution carries that memory's Evidence; each occurrence identifies a current, historical, or unknown revision.

The Web Settings Memory Center adds exact-scope list/detail caching, status/search filters, pagination, evidence and why-used views, candidate review, revision, and reason-required tombstoning. Connection reset and successful governance mutations clear cached values and retire pending read owners, so an older in-flight read cannot repopulate invalidated state. No retention/deletion policy was invented: expired rows stay visible, and delete remains an auditable tombstone.

The dialog selection and list query own independent response generations: dismissing a read must not reopen a dialog, and changing filters must not mix pages. Pagination failures retain usable rows with an explicit retry rather than silently appearing complete. Pending governance remains non-dismissible until acknowledgement, while invalid editor input stays local and visible. The [Memory Center package](../../../../packages/client/ui-memory-center/README.md) defines these interaction details.

A cache read retains its own caller result but may publish into the cache only while it remains the newest request for that key. List and detail caches share this mechanism, so a slow response cannot undo a completed fresh read without clearing unrelated pages.

## Alternatives considered

- **Use recall FTS as the management list** — rejected because FTS intentionally excludes tombstoned/superseded and expired rows and increments useful-access accounting by default.
- **Let the browser send arbitrary user/agent/workspace scopes for mutation** — rejected because an attached Session header is the authoritative workspace and provides durable user Evidence.
- **Treat a candidate approval as a silent status update** — rejected because active `user-stated` trust requires an inspectable user action.
- **Infer semantic conflicts** — rejected because the provider currently owns only explicit supersession facts; the UI does not fabricate contradiction certainty.

## Consequences

Memory now completes the default Contract → Provider → Composition → Remote → Client cache → UI vertical slice. Users can govern all canonical states and inspect provenance/freshness. Why-used is truthful but bounded to an attached selected Session. The later [cross-session outcome and conflict Note](2026-08-29-memory-outcome-conflict-and-cross-session-governance.md) closes cross-session aggregation, canonical review signals, deterministic/optional conflict detection, and explicit outcome-backed ranking.
