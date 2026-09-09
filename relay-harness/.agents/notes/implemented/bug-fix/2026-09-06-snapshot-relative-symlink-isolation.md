# Agent Note: Snapshot relative symlink isolation

Status: implemented

English | [中文](2026-09-06-snapshot-relative-symlink-isolation.zh.md)

## Problem

Copying an ACP snapshot workspace with the default filesystem copy options rewrites relative symlinks to the source checkout. An instruction link then leaves the generated workspace, so the instruction reader correctly refuses it. This also makes a supposedly isolated fixture depend on mutable source files.

## Decision

The [snapshot harness](../../../../packages/test-support/acp-snapshot/src/harness.ts) copies symlink text verbatim. Relative links resolve against the copied workspace; absolute links retain their explicit targets and are still subject to the reader's allowed-root policy. No reader boundary is relaxed.

## Verification

A POSIX regression creates a relative instruction link, checks its copied text, mutates the copied target, and verifies that the link reads the copy while the source remains unchanged. The assembled instruction snapshot retains baseline discovery, nested instructions, compaction restoration, and delimiter escaping assertions.

## Alternatives considered

Dereferencing all links loses the fixture's link semantics. Allowing the source checkout as another instruction root defeats isolation and conceals the copy defect. Refreshing an expected transcript without its missing instructions would remove the behavior under test.

## Consequences

The fixture tests symlink behavior instead of a dereferenced substitute. The symlink-creation regression is POSIX-only because Windows requires an additional privilege; the ordinary workspace seeding tests remain portable.
