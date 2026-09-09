# @relay-harness/rlh-spill-local

English | [中文](README.zh.md)

The **local-filesystem** implementation of the [`@relay-harness/rlh-spill`](../spill) storage seam. Registers as `ctx.spillStore` and persists a tool's oversized text to a private, session-scoped file; its locator is the file path and its retrieval hint tells the model to use `read` or `grep` on that path.

## Storage layout

Files land at `<root>/session-<hash>/​<random>-<safeName>`:

- **`root`** — the config `root` (resolved to absolute), or a lazily-created private (0700) per-process directory under the OS temp dir when omitted. A predictable, world-readable root would let other local users read spilled tool output or plant symlinks.
- **`session-<hash>`** — a short `sha256(sessionId)` prefix, so a session's spill files group together and session disposal can drop them in one step.
- **`<random>-<safeName>`** — an unpredictable hex prefix (defeats symlink planting in a shared root) plus the caller's `suggestedName` sanitized to one safe path segment (traversal-proof; mirrors the JSONL persistence backend's `encodeSegment`). The write is exclusive + owner-only (`open(path, 'wx', 0o600)`): it fails on any pre-existing path, symlink or not, so a planted target cannot redirect it.

## Config

| Key | Default | Meaning |
|---|---|---|
| `root` | private 0700 temp dir | Root directory for spill files. Set to keep them under a known location. |
| `orphanRetentionMs` | 604800000 (7 days) | Age at which a spill root left by an earlier process becomes reclaimable by the one-shot startup sweep over the OS temp dir's `rlh-spill-*` roots. The current process's own root is never removed. |

`saveText` rejects on a real storage failure (permissions, ENOSPC); the spill policy treats a rejection as best-effort and keeps the inline result. The backend reclaims a session's spill directory when that session is disposed. See the seam README for the vocabulary and the [tool output spill Agent Note](../../../.agents/notes/implemented/architecture/2026-07-08-tool-output-spill-files.md) for the design.

## Model Experience

Indirectly, through spill consumers that render the local path and `read`/`grep` retrieval guidance.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **Disposal and the orphan sweep are the only reclamation** — a session's spill files live until that session is disposed, and a root left by an earlier process lives until the startup sweep finds it expired; spill files of a still-live session are never reclaimed mid-session. Locators are best-effort recovery paths: a resumed or forked session whose spill files were already reclaimed reads them as a loud tool failure.
- **Locators require a co-located filesystem consumer** — a remote or virtual deployment needs another `SpillStore` backend whose locator and retrieval hint are meaningful there.
