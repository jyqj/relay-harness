# Agent Note: SDK server closeSession unregisters the id only after disposal settles

Status: implemented

English | [中文](2026-09-03-sdk-server-close-disposal-ordering.zh.md)

## Problem

Both SDK transports allow pipelined requests, and the server's `closeSession` removed the session id from the map before awaiting the agent's disposal. A `session/prompt` issued for the just-closed id without waiting for the close response therefore ran `ctx.agents.create` on the same SessionId while the old agent was still registered: the creation raced the old agent's unregister and surfaced as the prompt's JSON-RPC error `agent "main" is already registered`. The documented close contract — a later prompt for the closed id creates a fresh session — held only when the client happened to serialize its requests, making the contract timing-dependent on a client pattern the protocol does not forbid.

## Decision

`closeSession` keeps the record mapped until the disposal settles. The record gains a `disposeCompletion` promise set once the disposal begins; the id is unmapped by a continuation on that promise, so unregistration strictly follows the old agent's unregister. `getOrCreateSession` routes a closing id onto the in-flight completion and then re-resolves, creating the fresh session after the old agent is gone; a pipelined prompt waits for the bounded disposal quiescence instead of failing. `performShutdown` awaits an existing `disposeCompletion` rather than calling dispose a second time on a mid-close record.

## Alternatives considered

**Delete the id first and gate re-creation on a tombstone map of past disposals.** Rejected: it adds disposal state keyed by ids the server no longer owns; the live record is the natural owner of its own disposal, and tombstones would need their own cleanup.

**Fail a prompt that arrives mid-close with a dedicated "session closing" error.** Rejected: the close contract promises a fresh session for a later prompt, and pipelining is legal on both transports; erroring on a legal client pattern keeps the failure the contract already forbids, only with a new code.

**Only move `sessions.delete` after `await rec.handle.dispose()` without routing.** Rejected: the window just shrinks — a prompt arriving during the disposal still builds a second agent that races the old agent's unregister.

## Consequences

The close response now settles only after the agent's disposal reaches quiescence; disposal is a bounded abort, not a wait for an in-flight turn, so the close response is not unbounded. A pipelined prompt for the closing id resolves with a fresh handle and never observes `already registered` or `unknown session`. Two concurrent closes for one id now both settle after the single disposal; a close issued after the id is unmapped still fails loud with `unknown session`. Shutdown no longer double-disposes a record whose close is in flight. The server-options JSDoc no longer claims turn-outcome status mapping — `maxTokensAsSuccess` affects only `subagent.finished`, while root turns surface unmapped stop reasons in `RunResult.finishReason`. The ordering is pinned by `pipelines a prompt for a mid-close session onto the in-flight dispose` in `packages/sdk/server/tests/server.spec.ts`, and the close contract sentence in both server READMEs names the in-flight semantics.
