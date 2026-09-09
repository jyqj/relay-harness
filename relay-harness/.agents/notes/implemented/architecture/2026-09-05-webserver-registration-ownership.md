# Agent Note: Webserver registration ownership

Status: implemented

English | [中文](2026-09-05-webserver-registration-ownership.zh.md)

## Problem

A reserved-path register/dispose probe tests a synthetic example, not whether a real plugin leaves its route behind when unloaded. It can also collide with a legitimate route. Stale disposers and repeated transform functions require occurrence identity rather than handler identity.

## Decision

[Webserver](../../../../packages/host/webserver/README.md) dispatches from one authoritative set of registration records. Each record carries its captured route or handler, caller Fiber, and an activation fence owned by the caller's Cordis effect. Unloading or reloading that activation retires the fence even if the Fiber object survives. Manual disposal removes the exact occurrence and releases its fence; disposers are idempotent.

The package-private instance state uses a stable symbol so independently bundled service and invariant entrypoints read the same tables. The invariant waits through the owner's complete unload transition before checking for retained retired records. It performs no registration, request, or reserved-path probe. Async invariant failures are caught and reported through the logger instead of escaping as unhandled promises.

Route descriptors are captured at registration. Index taps are removed by registration occurrence, so removing the last of identical transforms does not remove the first or reorder intervening transforms.

## Alternatives considered

- **Probe a reserved path** — proves only the probe's disposer and may interfere with real routes.
- **Compare only Fiber ids** — same-fiber reloads retire an activation without changing its id.
- **Check at unload notification** — legitimate asynchronous cleanup can still hold registrations until quiescence.
- **Maintain a separate diagnostic route projection** — duplicates authority and can drift from request dispatch.

## Consequences

Registration records carry one small lifecycle fence; correct effect disposal removes both route and fence. The companion detects real leaked exact, prefix, upgrade, fallback, and transform registrations without becoming a route owner. Loader-backed HTTP and raw-socket tests cover precedence, mutation isolation, error containment, and teardown; lifecycle tests cover actual leaked and asynchronously released registrations and same-fiber reloads. The package's production sources meet the per-file coverage gate without a webserver exemption.
