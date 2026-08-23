# Agent Note: Explicit workspace checkpoint and rewind

Status: implemented

English | [中文](2026-08-21-explicit-workspace-checkpoint-rewind.zh.md)

## Problem

Workspace registration preserved directory identity and session grouping but offered no way for a host operation to establish a recoverable file boundary before risky edits. Conversation forks and retries cannot restore user files, while a blind whole-directory copy is expensive, captures unrelated secrets and build output, and has ambiguous behavior around symlinks and concurrent changes.

Automatic per-prompt rewind was not justified by a current caller. It would need to observe every filesystem effect, define conversation truncation, and decide whether shell and external-process writes participate. The useful current primitive is narrower: an explicit host-owned checkpoint over named paths and an explicit transactional rewind.

## Decision

The public `Workspace` entity exposes `checkpoint(paths)` and `rewind(checkpointId)`. The package remains host-only and registers no model tool or prompt. Checkpoint paths are workspace-relative, lexically contained, sorted, and deduplicated. Every existing component is inspected without following symlinks; a symlink, directory, special file, empty selection, more than 4096 paths, a single file over 64 MiB, or an aggregate over 64 MiB rejects before publication.

Each path records either confirmed absence or complete binary bytes plus permission mode. Records are versioned JSON in `<workspace>/.dsh/rewind-checkpoints/<sha256(workspaceId)>/<sha256(checkpointId)>.json`; raw caller ids never become path components. The store writes an owner-only `*` `.gitignore`. Checkpoint and restored file writes use same-directory random temporaries, fsync, rename, and final chmod. The returned `WorkspaceCheckpoint` contains the opaque id, capture time, sorted paths, and retained byte count.

`rewind(id)` strictly validates workspace ownership, id, unique normalized paths, snapshot tags, canonical base64, per-file byte declarations, and the complete byte total. It then preflights the current state of every path and captures a rollback snapshot before applying anything. Present snapshots replace bytes and mode atomically; absent snapshots unlink a current regular file or no-op when already absent. If a later apply fails, earlier paths are restored from the rollback snapshots in reverse order before the original failure is reported. A second independent rollback failure becomes an aggregate.

After a successful rewind, the store removes the selected checkpoint and every checkpoint with an equal or later capture instant. Older checkpoints remain valid. Corrupt unrelated JSON and non-JSON directory entries are ignored during this post-commit timeline cleanup; they never participate in the selected checkpoint's strict load.

This operation affects files only. It does not mutate Workspace registration records, session membership, conversation events, or Agent state, and it never runs automatically at a prompt boundary.

## Alternatives considered

**Automatically checkpoint every user prompt.** Rejected because no current host or UI owns the matching conversation-rewind transaction, and filesystem writes can bypass DSH tools through shell, subprocess, or external programs. An automatic promise would be incomplete.

**Snapshot the complete directory tree.** Rejected because it captures unrelated repositories, credentials, build artifacts, and large dependency trees. Explicit paths bound authority, storage, and review.

**Use Git commits or stash.** Rejected because workspaces may be non-Git, dirty, nested, or have user staging state that the harness must not rewrite. The checkpoint store is VCS-independent and gitignored.

**Store checkpoints in the storage domain.** Rejected because binary file rollback is co-located execution state, not Workspace registration metadata. Keeping bytes inside the workspace lets a workspace/rootfs snapshot carry them, while the storage domain remains small structured records.

**Follow symlinks and store resolved targets.** Rejected because a later symlink retarget can redirect rewind outside the workspace. The mechanism rejects every existing symlink component both at capture and apply.

**Apply best-effort without rollback.** Rejected because a failure after earlier paths changed would leave a hybrid state that matches neither the checkpoint nor the pre-rewind workspace. Preflight plus reverse rollback gives one operation owner.

**Rewind conversation and files together.** Rejected because Session logs are append-only and have separate fork/compaction semantics. A combined destructive operation needs an authenticated Host consumer and its own durable transaction.

## Consequences

Host code can bracket risky named-file operations with a durable local checkpoint and restore binary content, modes, creation, and deletion without touching unrelated paths. Successful rewind truncates its future file timeline, preventing a later rewind into state that was abandoned.

The store is local and single-process. It has no cross-process lease, directory recursion, automatic capture, shell-write interception, or exactly-once guarantee in the crash window before a checkpoint record reaches fsync. It rejects path-type races rather than following them. Rollback is best effort under a second independent filesystem failure and reports an aggregate when that occurs.

Tests cover public Workspace delegation, binary/mode and absence restoration, timeline truncation, malformed and foreign records, path escape, symlinks, directories, hard caps, atomic-write failure with rollback, corrupt sibling records, and missing ids. The package retains per-file 100% statements, branches, functions, and lines with only external double-failure races coverage-exempt.
