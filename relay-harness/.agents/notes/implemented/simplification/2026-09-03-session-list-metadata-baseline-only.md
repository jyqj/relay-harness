# Agent Note: sessionListMetadata projection is baseline-only

Status: implemented

English | [中文](2026-09-03-session-list-metadata-baseline-only.zh.md)

## Problem

The gateway's projection change feed minted a `session/projection` mux frame for every changed unit, including its own `sessionListMetadata` unit. That unit changes on every user message (`lastPromptAt`) and on the blank-to-nonblank flip, so each of those events pushed one frame to every mux subscriber. No client consumes the key: session rows fold blankness and recency from `host/session-added`, `host/session-status`, `user/message` activity frames, and the `session.list` / `session.history` projection blocks; a repository-wide search found zero readers of `sessionListMetadata` change frames. The sibling gateway-owned unit `imageLimits` already produced no frames (its `apply` keeps the state reference, so the registry never notifies), leaving the two gateway-owned units asymmetric on the same wire surface.

## Decision

The change-feed broadcast in `api-proxy.ts` now skips a declared baseline-only key set (`sessionListMetadata`, `imageLimits`), and both unit registrations document the marker. The values still reach clients exactly as before through the baselines — the `session.list` rows and the `session.history` tail projection block — so no client changed and no data became unavailable; only wire frames were removed. `imageLimits` is listed even though the registry never notifies for it, keeping both gateway-owned baseline-only units declared in one place and covering a future edit that makes its `apply` return a new reference.

## Alternatives considered

**Move the filter into the session-projection registry as a registration flag.** Rejected for now: the registry's change feed has other listeners with different consumer sets, so baseline-only is a carrier-side delivery decision; a registry-level flag would widen the seam package's contract for one carrier's need.

**Keep broadcasting and teach clients to ignore the key.** Rejected: ignoring frames at every subscriber re-pays the traffic on every session and still ships a dead frame vocabulary.

## Consequences

Per-user-message and blank-flip projection frames no longer reach mux subscribers, trimming one frame per event per subscriber on the busiest projection. Clients that somehow relied on the frames for the key lose nothing they read today, and the pre-release stance allows tightening the wire without a compatibility shim. The `api-proxy-mux.spec.ts` hygiene case pins the absence of the frames, and `api-proxy-projections.spec.ts` keeps the `test/last-user` push assertions as the guard against over-filtering.
