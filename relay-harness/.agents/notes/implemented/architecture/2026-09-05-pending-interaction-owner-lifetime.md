# Agent Note: Pending interaction owner lifetime

Status: implemented

English | [中文](2026-09-05-pending-interaction-owner-lifetime.zh.md)

## Problem

The Web question provider accepts an optional abort signal. A live Agent can therefore ask a valid question without one, then leave the registry while its question remains answerable and counted against its session id. The same lifetime gap applies to approvals, and a later Agent reusing the id must not inherit the old wait.

## Decision

[API Proxy](../../../../packages/host/apiproxy/README.md) retains each pending question or approval's exact Agent owner. The Agent registry's disposal event withdraws only waits belonging to that instance. Questions reject with `ASK_ABORTED`; approvals settle cancelled through their existing audit resolver. Both remove their entries before notifying clients, preserving first-claim ownership and making late rpcIds not pending.

Request-signal cancellation and gateway teardown remain independent triggers of the same cleanup. Wire projection carries only existing request fields, not the retained Agent object. A same-id successor starts with its own waits, and malformed answers cannot claim any existing wait.

## Alternatives considered

- **Require every caller to invent a cancellation signal** — duplicates the Agent registry's existing lifetime authority and leaves valid optional-signal calls unsafe.
- **Match only session ids at disposal** — can cancel a successor's requests rather than the disposing instance's waits.
- **Leave stale questions until a reply arrives** — retains pending counts and accepts an answer for work whose runtime owner has ended.

## Consequences

Each pending interaction retains its already-live Agent until settlement, and cleanup releases that reference. Service-to-mux tests cover valid and malformed replies, custom answers, client cancellation, step cancellation, gateway teardown, owner disposal without a signal, and same-id replacement. This closes a high-risk API Proxy coverage gap; it does not imply full API Proxy branch coverage or replace browser acceptance tests.
