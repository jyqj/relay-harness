# Agent Note: Align Code Index inputs with Git and parser ownership

Status: implemented

English | [中文](2026-08-30-code-index-input-and-corpus-ownership.zh.md)

## Problem

The parser registry classifies `.mjs`, `.cjs`, `.mts`, and `.cts`, while the default filesystem scanner omits them. A workspace can therefore advertise semantic parsing for a module that never enters the index; the recovered Auggie corpus exposes this mismatch because its executable source uses `.mjs`. The walker also ignores repository-local `.git/info/exclude`, so local reference checkouts excluded from Git can enter the product index and contaminate the Relay benchmark. The external-corpus incremental probe has an independent ownership risk: an existence check does not prevent another process from creating the path before the first write, and unconditional cleanup can then remove a path the runner never created.

## Decision

The default scanner admits all four JavaScript/TypeScript module variants, and extensionless import resolution probes the same variants. Each walk seeds its ignore stack from `.git/info/exclude`; a linked worktree resolves its gitdir and `commondir`. This document sits below root and nested `.gitignore` documents in the decision order, so a later negation retains Git precedence.

The corpus runner rejects an existing probe before temporary-store allocation and uses `wx` for the first incremental write to close the check/write race. It records probe ownership and removes the path only while that ownership is held. Runtime construction and the complete run settle into one outcome; probe removal, runtime disposal, and temporary-store removal are all attempted, with the run failure retained first when cleanup also fails.

## Alternatives considered

- **Exclude local reference directory names only in the corpus manifest** — rejected because the product index would still ignore the repository's own local-exclude decision.
- **Add only `.mjs` to satisfy the Auggie case** — rejected because the parser registry already promises the other three module variants and the same scanner mismatch applies to each.
- **Keep the preflight existence check as the only collision guard** — rejected because it has a check/write race and cannot prove that cleanup owns the path it removes.

## Consequences

Module-format source enters scan, parse, import resolution, retrieval, and hydration consistently. Git-local exclusions keep authorized reference trees outside the Relay corpus while the references remain independently measurable. The real Loader composition test boots the exact shipped Code Index and code-context rows, runs Session-scoped retrieval, calls Context Engine `prepareStep`, and observes verified hydrated source. The external runner passes the Relay, CodeCortex Rust, and recovered Auggie corpora; the package README records the measured file/chunk, latency, and Recall@5/MRR results.
