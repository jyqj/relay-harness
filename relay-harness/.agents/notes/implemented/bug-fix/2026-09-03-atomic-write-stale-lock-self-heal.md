# Agent Note: Stale writer locks self-heal on the same host with a provably dead owner

Status: implemented

English | [中文](2026-09-03-atomic-write-stale-lock-self-heal.zh.md)

## Problem

`withFileLock` created its `<file>.lock` sibling between `writeFile` and the `finally` removal, so a writer killed by `kill -9`, a crash, or a power loss left the lock behind permanently. Every later writer of that file — every credential set/unset (`rlh-credentials-local`), every settings patch (`rlh-settings-file`), plus presets, skill inventory, MCP server files, and `fs-local` — backed off for the full 2-second deadline and failed. Recovery was an operator action, and nothing in the repo swept stale locks, so one orphaned lock bricked those writes until manual deletion.

## Decision

The lock payload now records the owner host alongside the owner pid (`pid\nhost\n`; a repo-wide check confirmed no other reader parses the payload, so the format change is safe). On contention, before backing off, the contender reads the lock and removes it only when both conditions hold: the recorded host equals `os.hostname()`, and `process.kill(pid, 0)` throws with code `ESRCH` — the one signal that proves the owner process no longer exists. The healed contender retries acquisition immediately.

Every ambiguous outcome stays on the existing backoff-and-timeout path, which fails loud: an unreadable or malformed payload, a foreign-host lock (shared-filesystem deployments must not have their locks deleted by another machine), an alive owner — `EPERM` from the signal probe means the pid exists under another user and is treated as alive, not self-healed — and a lock re-created by a competing contender in the window after removal. A pid reused after a host reboot is treated as alive and remains an operator action; no zero-dependency portable boot identity exists to close that window, so it is documented rather than engineered around.

The protocol constants stay fixed: `LOCK_TIMEOUT_MS` and the retry curve are unchanged, and self-heal takes no Config field — it is a correctness property of the lock protocol, not a deployment-varying choice.

## Alternatives considered

**Self-heal on file age.** Rejected: the previous stance's core reason stands — age cannot distinguish a crashed owner from a paused live writer. Host-plus-liveness proof replaces the guess with evidence.

**Treat `EPERM` from `process.kill(pid, 0)` as dead.** Rejected: `EPERM` proves the process exists under another user. Deleting its lock would break live cross-user writers; treating it as alive fails loud instead.

**Remove the lock in a same-host sweep without liveness checking.** Rejected for the same reason as age: without `ESRCH` evidence, a sweep deletes live locks.

## Consequences

A crash or `kill -9` between lock creation and release no longer permanently disables credential, settings, and preset writes on that machine: the next contender removes the provably dead lock and proceeds. The safe direction is monotonic — today's outcome (timeout) remains the outcome whenever any ambiguity exists, and a live owner's lock is never deleted because a live pid returns success or `EPERM`. Consumers need no changes; they see only fewer lock timeouts. Old locks written by previous builds carry a single-line pid payload, which fails the host match and falls back to the operator-removal path until the operator clears them once.
