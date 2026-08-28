# Agent Note: Wire-boundary redaction hardening

Status: implemented

English | [中文](2026-08-26-wire-boundary-redaction-hardening.zh.md)

## Problem

Two wire-facing paths returned provider- or secret-bearing content to clients. `packages/settings/settings/src/redact.ts` walked only `object`/`dict`/`array` schema containers and returned any other node's value verbatim, so a `role('secret')` field declared inside a union, intersection, or transform crossed the boundary unredacted with an empty `secrets` record — the README documented this as a fail-open gap. And the `session.search` handler in `packages/host/apiproxy/src/api-proxy.ts` interpolated the raw provider error (`session search failed: ${String(error)}`) into its RPC error message, carrying upstream endpoints, query text, or credential fragments to the wire under an explicit `XXX: Redact provider details before exposing this gateway` marker.

## Decision

Both paths fail closed. `redactSecrets` refuses a schema it cannot prove safe: the walker's default branch runs a schema-only `declaresSecret` scan over `dict`/`inner`/`list` child relations, and a secret reachable only through an unwalked composite node throws (`refusing to redact a value whose schema declares a secret inside a <type> node at <path>`) instead of emitting an unredacted value. Unions and transforms that declare no secret pass through untouched, and the tolerance for structural nodes missing their relation maps is unchanged — a node with no relation map declares nothing.

The `session.search` catch classifies before it speaks. Failures the gateway itself constructed — the work-budget, oversized-page, and repeated-cursor guards, now thrown as `SessionSearchGuardError` — keep their messages on the wire, because those messages contain only counts and policies the handler measured. Typed `SessionQueryError` messages keep crossing too: the class is this repository's controlled provider vocabulary (`SESSION_QUERY_*` codes), not provider-thrown content. Every other error is provider-thrown with an unbounded message shape; those land in `ctx.logger.warn` (Host log only) and the wire gets the static message `session search failed`.

## Alternatives considered

**Deep-walk union branches per value.** A union value matches one branch, but the walker cannot know which without re-implementing schemastery resolution, and a wrong guess redacts the wrong path. Lost to the schema-only containment scan, which needs no value-level resolution to prove unsafety.

**Sanitize individual message fields on the wire.** The provider error's shape is unbounded, so no field list is complete. Lost to the static message; the Host log keeps the full detail.

## Consequences

A schema that hides a secret inside a union, intersection, or transform now breaks redaction loudly at the call site instead of leaking silently — registering such a schema on a wire-exposed namespace fails at the first `describe({ redactSecrets: true })`. Callers who previously "worked" against such a schema were already leaking, so no correct caller regresses. The still-open gap is `schema.toJSON()` carrying a secret field's `.default(...)` to every client; the settings README's Known Limitations entry keeps that gap and the deferred fail-closed `describeForWire()` as the remaining work.

## Testing

`packages/settings/settings/tests/redact.spec.ts` gains three cases: a secret-free union passes through, a secret inside a union throws, a secret inside a transform throws; the pre-existing container cases are unchanged. `packages/host/apiproxy/tests/api-proxy-search.spec.ts` keeps asserting the guard messages (budget, page size, repeated cursor) on the wire and its provider-failure case now asserts the static message — a plain provider `Error('database unavailable')` no longer reaches the wire. No e2e or snapshot asserted the old interpolated message text.
