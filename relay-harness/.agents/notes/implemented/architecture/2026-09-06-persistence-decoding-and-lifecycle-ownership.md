# Agent Note: Persistence decoding and lifecycle ownership

Status: implemented

English | [中文](2026-09-06-persistence-decoding-and-lifecycle-ownership.zh.md)

## Problem

A persistence coordinator that mixes historical event vocabulary, message identity reconstruction, writer scheduling, and backend repair requires readers to understand unrelated policies before finding the live state owner. Moving its mutable lifecycle maps into independent managers would make fencing and disposal depend on additional synchronization.

## Decision

The package-private [stored-event normalizer](../../../../packages/session/session-persistence/src/stored-events.ts) owns supported legacy shapes, deterministic message identities, prefix-dependent suffix classification, and snapshot-versus-adoption semantics. Borrowed records are copied; an exclusively owned backend array can be adopted in place. Identified messages become immutable, not the entire event envelope.

The [coordinator](../../../../packages/session/session-persistence/src/coordinator.ts) remains the sole owner of per-session operation chains, live attachments, preparations, retirement, and final mutation proofs. Both JSONL and SQLite adapters use the same decoding policy. The normalizer has no backend handles, timers, retained session maps, or mutation admission authority. Its functions are not additional public package exports.

## Verification

Shared coordinator and both backend contract suites cover recovery, suffix reads, unsupported vocabulary, retirement, and real cross-process takeover. Direct ownership tests distinguish borrowed snapshots from exclusive array adoption and verify immutable identified messages.

## Alternatives considered

A facade over the existing class would leave decoding and lifetime policy interleaved. A separate writer manager owning another per-session map would increase synchronization obligations. Deleting legacy normalization would change the accepted durable vocabulary rather than improve its locality.

## Consequences

The event vocabulary and persistence API stay unchanged. Decoding can be reviewed without following asynchronous lifecycle state; lifecycle changes still have one serialization and fencing owner.
