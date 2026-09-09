# Agent Note: SDK session/close reclaims runtime sessions

Status: implemented

English | [中文](2026-09-03-sdk-session-close-reclaims-runtime-sessions.zh.md)

## Problem

The SDK runtime protocol had no way to retire a session: `HarnessSdkJsonRpcServer` kept every `AgentHandle` in its sessions map from first prompt until process shutdown, so every `RelayHarness.run()` call on an auto-minted session id leaked one live agent — its loop, its in-memory session, and its session-log growth — for the runtime process lifetime. Every `run()` minted a fresh `session-<uuid>` id that no caller could ever reference again, yet nothing reclaimed it. The leak is bounded only by how many runs a deployment performs.

## Decision

The wire gains one client-to-server request, `session/close` with `SessionCloseParams { sessionId }`. The server's `closeSession` removes the record from its sessions map and disposes the handle; an unknown id answers a JSON-RPC error (`unknown session: <id>`) rather than reading as success, and a later prompt for a closed id creates a fresh session through the existing creation path.

The TypeScript client exposes `HarnessClient.closeSession(sessionId)` and threads it into `RelayHarness.run()`: a run on an auto-minted session closes that session in a `finally` once the run settles, while a named session stays caller-owned until `close()`. Named-session behavior is byte-identical to before. `RunResult` also gains `finishReason` — the interval's last `turn/end` `reason.kind`, or `null` when no turn ended — closing the projection gap with the Python SDK, which already reported it; a `turn/end` whose reason kind is not a string rejects as `SdkProtocolError`. The Python SDK mirrors `session_close` in its own change.

`HarnessClient.performClose` now fails every subscription even when no child was ever spawned: a subscription created before `start()` has no producer after `close()`, so parking its `next()` forever violated the documented "after close, rejects immediately" contract. Failures stay first-error-wins and idempotent, so this cannot disturb the existing runtime-death path.

## Alternatives considered

**Reference-count sessions on the server with an idle timeout.** Rejected because session lifetime is a caller decision: only the client knows whether an id will be reused, and a timeout either closes sessions a caller still wants (silent work loss) or needs a tunable that duplicates the explicit close.

**Mint no session until the first prompt and reuse one id per client.** Rejected because it changes observable session identity for every consumer (transcripts, lineage, subagent trees key on the id) and cannot express two concurrent sessions on one runtime.

**Return `finishReason` only from a new method.** Rejected because `RunResult` is the owned-run result surface both SDKs project; a side-channel would leave the TypeScript result permanently poorer than its Python twin.

## Consequences

A deployment that runs N prompts through `RelayHarness.run()` now retains zero agents after the last run instead of N; only named sessions accumulate, and their count is caller-visible by construction. Callers that held a `HarnessSession` from `harness.session()` without a named id and expected the runtime agent to outlive a `run()` on it see that agent disposed — no shipped consumer can reference a caller-unknown uuid, so the blast radius is limited to such speculative holds. A `session/close` for an id the caller never created now fails loudly where before the wire had no such method at all. The protocol method set grows from three to four request/result pairs; the example snapshots pin only `sessionId` and `finalResponse`, so no expected output changes.
