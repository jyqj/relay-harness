# Agent Note: Input submit attempts freeze the occurrence table with the draft

Status: implemented

English | [中文](2026-09-03-input-submit-attempt-occurrence-snapshot.zh.md)

## Problem

The submit pipeline spliced serialized reference model forms over inline display ranges using two sources captured at different moments: the draft came from the attempt's enter-time `draftSnapshot`, while the occurrence offsets came from `core.state.occurrences` read when the sink effect executed. The machine keeps accepting `draft-changed` while `adjudicating`/`submitting` (InputBar only blocks interactive editing at the UI layer, and `actions.setDraft` has no phase guard by design), so a write landing inside the adjudication window — an external mention insertion, for example — shifted the live table. The next `default-sink` effect then spliced enter-time draft text against shifted live offsets and produced a corrupted model form (`/ask @@[Research](…)`): the `@` of the display text survived beside the serialized reference.

## Decision

`SubmitAttempt` now carries the occurrence table alongside `draftSnapshot`, both captured in `InputMachine.beginAttempt` at enter time. `SessionInputShell.sinkSerialized` reads `attempt.occurrences` instead of the live table, making the splice basis self-consistent: draft and offsets describe the same moment. A busy-period draft edit therefore affects only the next send, matching the settlement rule that already lets user input typed during flight win.

No admission-phase guard was added to the machine or to `actions.setDraft`. Blocking writes during `adjudicating`/`submitting` would break the legitimate busy-period typing path (draft retention across the Host round-trip, suffix preservation on commit) and would force a migration of the `InputState` snapshot semantics consumed by the InputZone currency.

## Alternatives considered

**Reject `draft-changed` while busy (phase guard).** Rejected: `onSubmitSettled` already defines busy-period edits as the newer input that survives commit or wins rollback; a guard would invalidate that behavior and require reworking every consumer that reads `InputState` snapshots mid-flight.

**Capture the table inside the sink at effect-execution time.** Rejected: the plain-submit path executes `default-sink` synchronously and would stay correct only by accident; the adjudicating path resolves the effect after an async window, so any capture at sink time remains a second racing read rather than a fix.

## Testing

`input-machine.client.spec.ts` proves both enter paths (adjudicating and claimed→submitting) freeze the enter-time table on the attempt and that a busy-period edit shifts only the live table. `input-reference-submit.client.spec.ts` replays the defect end to end: a chip-bearing `/` line enters adjudication, `actions.setDraft` prepends text during the window, and the sink must receive the enter-time projection (`/ask @[Research](…)`), not the mis-spliced `@@` variant. The full `packages/client/ui-conversation/tests` directory passes.

## Consequences

Serialize-then-splice is now correct for every interleaving of external writes with the submit transaction. The attempt object grows by one array reference per send (the frozen table is shared, never copied). The InputBar busy guard stays a presentation-layer concern, and its comment now states that contract explicitly, as do the `SubmitAttempt` and `InputActions.setDraft` JSDoc.
