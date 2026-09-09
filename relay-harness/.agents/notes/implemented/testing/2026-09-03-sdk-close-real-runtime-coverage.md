# Agent Note: SDK close paths gain real-runtime wire coverage

Status: implemented

English | [中文](2026-09-03-sdk-close-real-runtime-coverage.zh.md)

## Problem

The R5 session/close path was exercised only in-process against fake handles (`server.spec.ts`) and against the scripted fake runtime (`fake-runtime.ts`, the Python fake peers). No harness booted the real `rlh-jsonrpc-agent` runtime and closed a session over the wire, so the interaction the method exists for — dispose quiescence, session-log flush, and teardown ordering — was unproven on both SDKs. The prompt-then-close-immediately case had no coverage anywhere. In the same seam, neither SDK's keyless expected outputs pinned the R5 headline parity field `finishReason`/`finish_reason`, and two doc surfaces described wire behavior that does not exist: `SdkProtocolError`'s example claimed a `session/prompt` response is validated for `accepted: true` while the validation reads `messageId`, and the fake-runtime comments repeated the same claim.

## Decision

The TypeScript snapshot harness (`examples/jsonrpc-agent/tests/sdk.snapshot.ts`) now projects `finishReason` in `normalizeResult`, and its committed `result.expected.json` files pin the field. A shared `openRuntime` opener extracts the env/launch assembly from `runScenario`, and the close-path describe runs these real-runtime probes in replay mode:

- `close-auto-session` runs `RelayHarness.run()` without a session id and proves the automatic reclaim: a second `closeSession` for the minted id rejects with `unknown session`, and an identity-bound read observes that exact completed turn in the durable log.
- `close-named-session` closes an explicitly named session, proves the id is released (second close rejects), and proves the closed id's persisted log stays intact.
- `close-mid-turn` gates the close on the first streamed `assistant/chunk` using a `replay.override.json` sidecar whose single `hang` entry stalls until cancelled, then asserts the client observes `turn/end { kind: 'aborted' }` and terminal idle, and that the durable log ends with the aborted turn.

- `close-reprompt` resumes the same durable identity after close and checks the exact second answer, increasing turn identity, and retained first-turn byte prefix.
- `close-pending` closes before the first response chunk and identifies the durable aborted ending by the exact observed event.

The Python smoke (`scripts/smoke-python-runtime.py`) gains an `sdk-close` scenario (exe-required, included in `--scenario all`) mirroring the auto, named, and mid-turn probes against the mock model: the auto-close probe re-closes the minted id and expects `JsonRpcError: unknown session`, the named probe closes and re-closes explicitly, and the mid-turn probe closes while the mock's stream is paused after its first chunk, then asserts the SDK's own `finish_reason` projection reports `aborted` at terminal idle. The mock handler streams the probe's first two chunks, flushes, pauses, then continues, and tolerates the `BrokenPipeError` of the connection the aborted turn abandons. `build_snapshot_files` pins `finish_reason` in the advanced `result.json`, re-recorded in the same change. The stale `accepted: true` doc claims are rewritten to the real `messageId` validation.

## Discovered defects (out of this change's scope)

Driving the close path on a real runtime surfaced two behaviors this slice pins around rather than fixes, because both fixes belong to files outside the slice:

1. **Re-prompting a closed id violates the documented fresh-session contract.** After `session/close`, a prompt for the same id is accepted and runs, but the fresh session collides with the durable log in the persistence coordinator (`adoptLivePrefix` → `seedCoversPrefix` fails for an empty seed) and the turn ends with `turn/end { kind: 'error' }` carrying `session "X" already has a persisted log on disk ... (id collision)`. Nothing of the fresh session persists, silently. The server contract and the SDK client JSDoc both promise "a later prompt for the closed id creates a fresh session". A follow-up must either route the re-creation through the resume path or scope the collision guard to concurrent lifecycles; the probe fixtures deliberately do not pin the broken outcome.
2. **Closing before the first streamed chunk skips `turn/end`.** The mid-stream close (first chunk observed, then close) deterministically yields `turn/end { kind: 'aborted' }`. Closing while the model request is still pending (response not yet started) publishes terminal idle with no `turn/end` at all. The two cancellation windows disagree on the wire vocabulary; the mid-stream window is the one the R5 in-process verification covered.

Operating note: the committed `dist-exe` artifact predated `session/close` and answered `unknown Relay Harness SDK runtime method`; repackaging from current `lib/` (`pnpm exec tsx scripts/build-exe-for-python-sdk.ts --skip-build`) restored the exe used by the Python smoke.

Every completed close probe binds its persistence barrier to the SDK run’s actual Session id, turn number, closing event sequence, assistant-message id and sequence, and exact answer. Auto and named close prove identity release separately from observing the corresponding durable write-behind commit. Re-prompt resumes the same persistence identity: the second turn increments its turn number, preserves the first log byte-for-byte as a prefix, and stores exactly `SDK snapshot OK` followed by `SDK re-prompt OK`. Aborted probes likewise wait for their exact streamed turn/end rather than any matching reason. A real-file delayed-append regression leaves the first completed tail on disk while waiting for the second answer, proving that an old `completed` tail cannot satisfy the new barrier. Snapshot normalizers and golden comparisons remain unchanged.

## Alternatives considered

**Snapshot the close scenarios' notification streams like the turn scenarios.** Rejected for the re-prompt probes (they would enshrine defect 1) and unnecessary for the others: the probes assert the close contract's behavior (release, log intactness, aborted ending) deterministically, and the turn scenarios already pin the stream vocabulary.

**Gate the mid-turn close on a paced replay (`paceMs`) instead of a hang override.** Rejected because pacing is a timing knob — a fast machine can still complete the turn before the close lands — while the `hang` entry makes the abort the only way the stream can end.

**Prove the auto-close by re-prompting the minted id.** Rejected because of defect 1; the re-close (`unknown session`) assertion proves ownership release without touching the persistence collision.

## Consequences

A regression in the close path, in the abort vocabulary, or in the SDKs' turn-ending projection now fails a keyless suite on both SDKs. The committed expected outputs pin `finishReason`/`finish_reason` next to `finalResponse`. Both discovered defects are now closed — the re-prompt-after-close contract through the SDK server's resume path, and the pending-request cancellation window, which no longer reproduces on the current agent-loop — with regression probes at the unit, replay-entry, and real-runtime levels ([sdk-close-reprompt-resume](../bug-fix/2026-09-03-sdk-close-reprompt-resume.md)).
