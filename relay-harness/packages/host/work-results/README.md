# @relay-harness/rlh-host-work-results

English | [中文](README.zh.md)

Host adapter for explicit result-record confirmation and cross-session output discovery. Session logs remain the only durable authority; this package creates no Work database and never changes a goal's phase. It owns the pure `deliverables` and `workAcceptance` projections; the existing carriers publish them and `ui-product-shell` consumes them. `ui-deliverables` owns only response guidance and per-turn presentation.

## Confirmation

`workResults/accept` requires the original active trusted Connection request for that exact endpoint and no agent initiator. The client supplies the reviewed non-acceptance log sequence. The Host requires the exact live root agent, a closed turn, no pending inbox, no owned running/stopping jobs, and no pending ApiProxy approval/question. The existing Agent maintenance transaction serializes confirmation with other maintenance and queues new driving input; after the initial flush, the Host rechecks caller, cancellation, eligibility, and revision immediately before appending `work/accepted`.

The receipt records `reviewedThroughSeq` and `actor: 'host-client'`. It does not invalidate itself; subsequent log facts do. A same-revision retry reuses the receipt, while a concurrent maintenance claimant may be refused. Success returns only after a durability barrier and a physical read confirms the receipt. Failure to receive success does not prove absence: a later retry can confirm an already-recorded receipt without appending another.

`workResults/get` captures one review cut before awaiting, flushes accepted work, and checks the physical receipt and stored tail covering that cut. It returns `verifiedThroughSeq` and whether the captured cut is still current, never promotes a later in-memory sequence into a durability claim. A raw projection is not proof of persistence. Clients verify only at quiet review points; streaming changes invalidate earlier confirmation without causing per-chunk flushes.

These are confirmations submitted by the existing trusted Host client, not cryptographic evidence of a physical human click. All four endpoints are loopback-only under the existing Connection policy. Confirmation grants no agent permission, proves no test result, and does not attest unchanged files or a completed subagent tree.

## Library and native opening

`workResults/list` scans bounded pages of existing Session Query logs without activating agents or scanning device files. It filters execution-captured output paths, returns their source Session ids, and reports scanned/total sessions, uncaptured historical results, unavailable sessions, and continuation. The opaque continuation revision binds the normalized query, Session order, live output projections, and cold storage revisions; changed relevant facts require restarting instead of silently missing earlier-page outputs. Before-and-after revision checks reject a moving scan rather than claim a consistent completed page.

`workResults/open` accepts a source Session id and an exact recorded path. The record proves provenance, not authorization. Relative paths use the source directory, never the currently selected workspace. Explicit external files and introduced symlinks remain subject to the existing privileged Host opener; this adapter invents no cwd-only grant rule. The Host rechecks source membership and rejects a canonical target changed during the operation before invoking the existing `apiProxy.host.openPath` in the same request, preserving native refusal and cancellation without a client-side check/open round trip. Paths are locators, not immutable file identities.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `scanSessionsPerPage` | `20` | Maximum Session logs inspected per page, from 1 through 100. |
| `maxResultsPerPage` | `100` | Maximum requested output rows, from 1 through 500. |
| `defaultResultsPerPage` | `50` | Default row limit; cannot exceed the maximum. |

## Model Experience

### Result-record confirmation

#### What the model sees

No new prompt, tool, or model-visible message. `work/accepted` is log-only; SDK session-event notifications preserve the receipt without changing `deriveMessages()`.

#### Token effect

Zero additional model tokens.

#### KV Cache effect

Existing model-visible prefixes are unchanged.

## Known Limitations and Deferred Work

- Confirmation binds a Session log prefix, not file hashes. External file edits need not append events; resume bookkeeping can conservatively make a receipt stale without a new model turn.
- Native opening requires Host-visible files. Remote execution worlds need their own export/locator adapter; this feature does not download or read remote output bytes.
- Library pages are bounded observations, not retained immutable corpus snapshots. Unavailable history and legacy uncaptured results are reported, and concurrent relevant changes can require retry.
- Host-client provenance inherits the existing loopback/browser trust boundary, not an independent authentication or physical-user attestation system.
