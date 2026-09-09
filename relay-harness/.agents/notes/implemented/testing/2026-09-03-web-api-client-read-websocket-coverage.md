# Agent Note: WebApiClient.readWebSocket gains parser coverage

Status: implemented

English | [中文](2026-09-03-web-api-client-read-websocket-coverage.zh.md)

## Problem

`WebApiClient.readWebSocket` is the browser's only wire parser: every mux and host downlink frame the web client accepts passes through its JSON parse, two-level zod validation, and wake-based inbox. Before this change, its behavior was exercised only incidentally through `client-apply.client.spec.ts`'s assembled loop, and several parser guarantees had no direct witness anywhere: a malformed JSON frame must be dropped without ending the stream, a JSON frame whose payload fails the frame schema must be dropped the same way, an abort during `CONNECTING` (before any frame) must close the socket and end the stream, and a server close that arrives before `open` must end the stream without a hang.

## Decision

`packages/client/connection/tests/web-api-client.client.spec.ts` drives `WebApiClient.readWebSocket` directly against a manually driven `StubWebSocket` (tests fire `open`/`close`/`receive`; no auto-open, unlike the fixture in `client-apply.client.spec.ts`). Five probes cover: malformed JSON dropped with `console.error` while the next valid frame still yields; a schema-invalid payload dropped the same way, with neither bad frame reaching the envelope observers; abort during `CONNECTING`; abort during `OPEN` (after `onOpen` fired); and close-before-open ending the stream with `onOpen` never called. The probes also assert `onEnvelope` sees only validated frames, pinning the two-level parse discipline's drop-first-observe-later order.

## Alternatives considered

**Extend `client-apply.client.spec.ts`'s existing WebSocket coverage.** Rejected: that spec asserts assembled loop behavior through `apply()`; the parser contract needs direct socket control (no auto-open, abort in `CONNECTING`, pre-open close), and a separate spec keeps the browser half's file from doubling again.

**Test through `ConnectionController` with a real server.** Rejected: a real carrier adds no parser evidence the stub cannot produce deterministically, and reconnect/backoff machinery would interleave with the drop-and-continue assertions.

## Consequences

A regression in the browser's frame parser — a malformed frame that wedges or kills the stream, a dropped-frame `console.error` that vanishes, an abort or early close that leaves the generator pending — now fails a focused keyless suite. The remaining unwitnessed branch of `readWebSocket` is binary (non-string) message data, which shares the malformed-frame path with the JSON probe.
