# Agent Note: Preset generation leases

Status: implemented

English | [中文](2026-09-05-preset-generation-leases.zh.md)

## Problem

A composition edit creates a new standing subtree, but the previous subtree can still serve parent agents, inherited subagents, and asynchronous cold readers. Retaining every old subtree leaks live watchers; releasing it on cache replacement breaks those consumers. A bare standing scope key provides no lifetime information.

## Decision

[Agent Presets](../../../../packages/preset/agent-presets/README.md) counts holds on each generation. Agent joins retain a hold owned by the agent context's Cordis effect. Child inheritance retains the exact parent generation, including a superseded generation. Recomposition acquires the replacement before moving the parent binding and releases the previous hold afterwards. Cache invalidation marks a generation retired; only a retired generation with zero holders disposes its scope. One current generation remains cached per preset.

`acquireStandingScope()` gives cold readers a key and idempotent asynchronous release. API Proxy holds it through history presentation or asynchronous skill listing and releases it in `finally`, including error paths. No cold reader receives a permanently retained bare key. Concurrent mounting remains single-flight; failure cleanup only removes its own cache promise and cannot erase a successor.

## Alternatives considered

- **Count only live agents** — misses cold readers suspended in asynchronous registry operations.
- **Dispose on every edit** — invalidates running parent and child capabilities.
- **Keep every generation until shutdown** — retains watchers proportional to editing history.

## Consequences

Old generations live for their actual consumers instead of the entire process. An agent or reader that never releases still retains its generation; explicit ownership cannot repair a consumer leak. Current cached generations retain their watchers until invalidation or host shutdown. Teardown waits for subtree quiescence; cleanup errors are reported without reversing an already committed rebind or authoring operation. Real Loader tests close a real filesystem watcher only after the final holder exits, preserve inherited capabilities after parent exit, and bound repeated cold-read edit cycles to one cached generation. API Proxy tests retain leases across asynchronous success and failure.
