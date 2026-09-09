# Agent Note: asynchronous preset reads hold exact generations and ancestry

Status: implemented

English | [中文](2026-09-05-preset-read-scope-leases.zh.md)

## Problem

A cold-reader lease protects standing effects, but a live Agent key can be rebound while a skill catalog awaits providers. Releasing the last Agent hold can also reclaim a retired generation before its reader settles. Retaining the generation alone does not freeze the live key's ancestry, and replacing the key with the standing key drops agent-specific overlays and restrictions.

## Decision

`captureScopeReadView` stores an immutable chain of original registration identities behind an opaque read token. `scopeChainOf` resolves it, and `ScopedLayers.peek` preserves the exact original layer. Mutable scope creation, ancestry binding/rebinding, and event dispatch reject read tokens. The view freezes ancestry only: registry contents retain their own revision rules and effects retain their owners' lifetimes.

`AgentPresets.acquireAgentScope` synchronously retains the joined generation and captures the complete Agent ancestry. The gateway uses it for live history and asynchronous skill reads and releases it in `finally`. Cold reads continue using `acquireStandingScope`. A recompose cannot turn an existing read into a replacement preset; Agent-owned effects may disappear under their existing revision policy without adopting a successor Agent. The [standing-mount decision](2026-08-08-per-preset-standing-mounts.md) still owns composition and inheritance.

## Alternatives considered

**Only retain the generation while passing the live key.** A provider retry still traverses the rebound parent chain.

**Pass the standing key instead.** This loses the Agent's own registration layer and exact-scope restrictions.

**Clone registration keys or freeze registry values.** Cloned identities see no original registrations. Copying all mutable registries would bypass their own revisions and lifecycle rules.

## Consequences

No new Session owner or model input exists. Independent tests cover failed duplicate joins without leaked holds, removal with a live cold reader, recompose and Agent disposal during a retained live read, exact-layer restrictions, read-token mutation/dispatch rejection, and gateway release on successful and failed asynchronous skill reads. Resource ownership stays separate from immutable lookup ancestry.
