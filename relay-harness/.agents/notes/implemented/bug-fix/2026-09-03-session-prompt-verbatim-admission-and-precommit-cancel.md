# Agent Note: session.prompt verbatim admission, pre-commit cancellation, and rpcId idempotency

Status: implemented

English | [中文](2026-09-03-session-prompt-verbatim-admission-and-precommit-cancel.zh.md)

## Problem

The `session.prompt` Service Definition promised a host-side slash-command dispatch that no implementation ever provided. Three surfaces described it — the `command?` response slot, the `command-error`/`unknown-command` error codes, and the claim that a leading-'/' prompt "is never sent to the model" — while the gateway actually admitted every prompt verbatim and the real command channels live elsewhere (the client-side commands channel, the host-side `command.execute` RPC). The dead surface was not just cosmetic: it told SDK and UI consumers a wire behavior that would silently mislead them about what reaches the model.

On the same route, the failure directions of client and host pointed opposite ways. The fetch carrier bounds every unary call with a 30-second transport deadline and honors dispose/release aborts, but the handler dropped the carrier signal before `sessions.prompt` reached the gateway, and the R5-B per-session operation slot lengthens the pre-admission wait (a prompt can queue behind a `selectModel` or a preset swap's recompose). A stalled host therefore left the client reporting failure with the draft retained while the gateway still admitted the message and opened a turn — and the composer's resubmit delivered the same text twice.

## Decision

Three movements on one route.

**Delete the dead contract surface.** The `command?` slot leaves the prompt response type and `sessionPromptValueSchema`; the `command-error`/`unknown-command` rows leave `RpcErrorDetailsMap` and the wire error schema, so the closed union refuses both codes outright. The Service Definition JSDoc now states the actual behavior: a leading-'/' line reaches the model as literal text; command execution never happens on this route.

**Forward the carrier signal and honor it only before the commit.** `UNARY_ROUTES` forwards the carrier signal into `sessions.prompt(request, signal)`. Inside the serialized admission slot, the signal is checked at entry and again just before durable content intake starts; either check answers `cancelled` and nothing reaches the inbox. Once intake starts, the admission completes regardless — admission is non-rolling, so there is no half-admitted state and no rollback of already-durable image objects. The pre-existing `cancelled` code carries the answer.

**Dedup by request identity.** The gateway records each admitted prompt's rpcId per session in a bounded recent-admissions window (fixed at 32, a bookkeeping bound, not a deployment tunable). A re-admission of a recorded rpcId answers `accepted` again without touching the inbox, and the guard is per session — the same rpcId on another session (fork/resume lineage) admits normally. This makes the mismatch above safe to retry at the protocol level. One limit is recorded honestly: the shipped composer mints a fresh rpcId per call, so today the guard protects callers that reuse request identities rather than the composer's own resubmit path; client-side rpcId reuse on retry is future work in the runtime session, outside this change's files.

## Alternatives considered

**Reject leading-'/' prompts with a new error code.** Rejected: users legitimately ask questions beginning with '/', the agent loop already interprets skill tokens at the pre-step boundary (model-visibly, per the skill catalog contract), and a rejection would add a second command vocabulary on the wire while the first one just died.

**Rolling cancellation through the durable intake.** Rejected: image admission commits durable attachment objects batch-wise; aborting mid-batch would need per-object rollback to keep the durable surface consistent, for a window (one image batch) that is not worth the machinery. Cancellation before intake is total; after intake the prompt is delivered — a clean dichotomy the docs now state.

**Unbounded rpcId history.** Rejected: a retry can only race a recent admission, so retention past a small window guards nothing while growing with the session. The window bound stays a fixed constant in the gateway.

## Consequences

The `session.prompt` response value is a bare `{ accepted: true }`: a stray command key from an old peer is stripped by the value schema, and parsing either retired error code now throws at the closed union. An aborted or timed-out prompt that has not started durable intake returns `cancelled` with a provably empty inbox; one that has, returns `accepted` to a caller that may no longer be listening — and the client-facing comments (facade, Service Definition, apiproxy README) now say "may have been delivered" instead of claiming the abort terminates the Host round-trip. A duplicate same-rpcId admission is an idempotent `accepted` with one delivery. Pinned by tests: the schema reversals in `rpc-schemas.spec.ts`, and in `client-handler.spec.ts` a real-gateway block covering verbatim-'/' admission, queued-abort cancellation (inbox untouched), post-intake admission survival, and per-session rpcId dedup with the cross-session escape. Remaining outside this change: the composer's promptError toast copy could phrase the failure as "the send may still have arrived" in product copy; that text lives in the runtime session/InputBar surfaces, which belong to other slices' file sets.
