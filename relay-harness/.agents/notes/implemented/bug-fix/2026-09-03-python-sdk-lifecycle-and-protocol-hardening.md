# Agent Note: Python SDK lifecycle and protocol-validation tightening

Status: implemented

English | [中文](2026-09-03-python-sdk-lifecycle-and-protocol-hardening.zh.md)

## Problem

The Python SDK carried four silent surfaces while its TypeScript twin had already tightened each one, and the two sides had drifted:

1. `HarnessClient.start()` checked the process handle and ran `Popen` outside the lock. Two threads calling `start()` concurrently (for example the implicit start behind concurrent `RelayHarness.run` calls) spawned two runtimes; the second handle overwrote the first, and the orphan's reader thread could even attach to the winner's process.
2. `close()` returned immediately when the client had never started, without failing waiters: subscriptions created before start polled `next()` in a 50ms loop forever after close. Close was also restartable — `start()` after `close()` silently spawned again, contradicting the terminal contract the TypeScript side already documents.
3. Initialize validation used an all-optional pydantic model, so `{}`, `null`, and mangled `serverInfo` objects all passed silently; a non-dict `session.event` envelope was silently skipped, and an `assistant/message` event without content returned a successful result with `final_response=""`.
4. Every `run()` minted a fresh session id, but the protocol had no `session/close`, so the runtime-side agent and session-ownership tracking were never reclaimed; the teardown ladder also had only the 1s shutdown timeout with no stdin-EOF grace.

## Decision

`start()` now budgets args and environment outside the lock, then spawns, assigns the handle, and registers the reader/stderr threads inside `self._lock` with a handle re-check — concurrent `start()` calls spawn exactly one runtime. `RelayHarness.start()` serializes the same way with a `threading.Lock`, so a double initialize is no longer reachable.

`close()` sets `_closed` and is terminal: a later `start()` raises `TransportClosedError("Relay Harness runtime client is closed")`, and closing with no process still fails waiters before returning. The teardown ladder mirrors TypeScript: best-effort `shutdown` request bounded by `shutdown_timeout_seconds`, stdin EOF, an `eof_grace_seconds=6.0` cooperative window, terminate, a `terminate_grace_seconds=3.0` window, then force kill. Both fields live on `HarnessConfig` and `RelayHarnessConfig` rather than hard-coded constants.

`ServerInfo.name/version` became required `str` fields and `InitializeResponse.serverInfo` is required; `initialize()` catches `ValidationError`/`TypeError` and raises `SdkProtocolError("initialize returned no server identity: …")`, matching the TypeScript message. `api.py` gained `_validated_session_event`: the envelope must be a dict carrying a string `type`, and `assistant/message` must carry kind-tagged content blocks, or a `SdkProtocolError` is raised. `final_response` dropped the `data.content` fallback and reads `data.message.content` only — once validation runs first, that fallback is an unreachable defensive path, and keeping it on one side violates the single-read-path convention between the twins.

`HarnessClient.session_close(session_id)` mirrors the TypeScript `session/close` request (an unknown id is rejected by the runtime; callers may only close sessions they created). `RelayHarness.run()` reclaims an auto-minted session in a `finally` when no `session_id` was passed — no caller can reference a uuid it never saw — while named sessions remain owned by their caller.

## Alternatives considered

**Keep close restartable and let `RelayHarness` swap in a fresh client after a failed handshake.** The TypeScript `RelayHarness.start()` does replace its client instance after a failed handshake, but the Python low-level `HarnessClient` has no rebuild entry point, and adding one is new capability, not tightening; the pre-release stance favors contract alignment (close is terminal), and consumers that need several runtimes should hold several clients.

**Keep the `data.content` fallback and copy it into TypeScript.** Rejected: once Python validates, the fallback is dead, and having TypeScript copy a dead path would invert the trust-TypedScript-boundaries rule into bidirectional defensive duplication.

## Consequences

Concurrent start moves from a racy double spawn to one serialized spawn; the second caller blocks for at most one spawn duration. Subscriptions created before start now reject immediately with `TransportClosedError` instead of hanging forever — the behavior both sides already documented. An abnormal teardown slows from about 1s to at most the 6s+3s grace ladder, and only on that path. A non-conforming runtime now fails loud in Python instead of returning silent success. The agent behind an auto-minted session is disposed once `run()` returns; the explicit `session_id` path is unchanged. Existing fake-bridge tests gained the real runtime's `serverInfo.version` and `data.message.content` shapes.
