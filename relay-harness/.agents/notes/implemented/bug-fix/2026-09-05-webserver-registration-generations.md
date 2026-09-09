# Agent Note: Webserver registration generation ownership

Status: implemented

English | [中文](2026-09-05-webserver-registration-generations.zh.md)

## Problem

An HTTP, upgrade, or fallback disposer removed the route at its old address even after that address had a new owner. An index-tap disposer could likewise remove a later registration of the same function. Calling the old disposer twice therefore removed live registrations belonging to another occurrence.

## Decision

Every registration returns a one-shot disposer. Its occurrence is retired before cleanup, so duplicate or reentrant cleanup cannot remove a successor. Route cleanup retains the key used at registration instead of rereading the caller's route object.

## Consequences

Disposal remains synchronous and repeated calls are no-ops. No request path or route precedence changes. The real Loader composition tests exercise exact and prefix HTTP responses, upgrade ownership, fallback responses, and reuse of the same transform function after a stale disposer runs. All five regressions fail without occurrence ownership and pass with it.

## Alternatives considered

Comparing only handler or route identity is insufficient because the same function or route object may be registered again. Global cleanup or rejecting reused addresses would break plugin reload rather than enforce ownership.
