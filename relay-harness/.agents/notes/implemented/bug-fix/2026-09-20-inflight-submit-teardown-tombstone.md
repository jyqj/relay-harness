# Agent Note: A submit in flight at scope teardown defers the discarded-draft tombstone

Status: implemented

English | [中文](2026-09-20-inflight-submit-teardown-tombstone.zh.md)

## Problem

`InputHub`'s session-scope teardown projected the composer draft and recorded a discarded-draft tombstone whenever the projected text was non-empty — including when a submit was mid-flight to the Host. The shell's dead-attempt guard then swallowed the settlement, so the tombstone claimed unsent input the Host may have accepted. On reopen the user saw a "discarded draft" notice for a message that had actually been sent, and the text returned to the composer next to the delivered message.

## Decision

- `SessionInputShell` counts default-sink sends awaiting the Host round-trip (the machine submit path and the image-only direct send) and exposes two wiring-layer faces: a `submitInFlight` read and `afterDisposeSubmitSettle(cb)`, which registers the one callback invoked at settle even after disposal, with whether the send was accepted.
- Hub teardown checks in-flight state before disposing. With a send in flight it registers the settle callback instead of discarding; without one it records the tombstone immediately, as before. The callback records the tombstone only when the settle did not report acceptance — an error outcome, or a rejection, which the existing image-send semantics already read as "may not have arrived". If the scope is gone at settle time and the Host accepted, no tombstone is recorded.
- The tombstone text is the clipboard projection frozen at teardown; the persisted `DiscardedDraftRegistry` shape is unchanged.

## Alternatives considered

**Suppress the tombstone for in-flight submits unconditionally.** Rejected: a failed send would then destroy the user's text silently — the exact loss the tombstone exists to prevent.

**Add an explicit "uncertain" tombstone variant.** Rejected: by settle time the outcome is always known (accepted, error, or rejection), so no third state carries information; a new variant would also touch the persisted entries shape and every reader for no behavioral gain.

**Clear the draft optimistically at submit, like the success path.** Rejected: the draft must survive a failed send for correction. Only the settle outcome distinguishes "taken" from "failed, keep it".

## Consequences

- An accepted send no longer leaves a false tombstone when its session scope is torn down mid-round-trip; a failed send still retains the text through the tombstone.
- A transport that never settles (a hung Host round-trip) records no tombstone, since the answer never arrives; the attempt signal is aborted at dispose and the default sink is required to settle on abort, so this window is bounded by the transport's own failure behavior.
- The in-flight count covers only default-sink sends; command-plane claims (`claim.submit`) keep their existing transaction semantics and were never tombstone inputs.
- Regression coverage: the ui-conversation draft-lifecycle spec tears the scope down mid-submit and asserts the deferred outcome — no tombstone on acceptance, the frozen text tombstoned on failure.
