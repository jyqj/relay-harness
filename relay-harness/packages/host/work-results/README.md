# @relay-harness/rlh-host-work-results

English | [中文](README.zh.md)

Host adapter for explicit result-record confirmation and cross-session output discovery. Session logs remain the only durable authority; this package creates no Work database and never changes a goal's phase. It owns the pure `deliverables`, `workAcceptance` and `workContentReviews` projections; the existing carriers publish them and `ui-product-shell` consumes them. `ui-deliverables` owns only response guidance and per-turn presentation.

`workResults/get` also returns `confirmationBlockedBy`, sampled from live root membership, closed-turn state, Agent status, queued input, Host approvals/questions, and owned background Jobs. These read-time reasons are advisory, not authorization or persistence evidence. The same pure policy is applied again by the maintenance-protected confirmation path; a client cannot convert a previous eligible read into a grant.

## Confirmation

`workResults/accept` requires the original active trusted Connection request for that exact endpoint and no agent initiator. The client supplies the reviewed non-acceptance log sequence. The Host requires the exact live root agent, a closed turn, no pending inbox, no owned running/stopping jobs, and no pending ApiProxy approval/question. The existing Agent maintenance transaction serializes confirmation with other maintenance and queues new driving input; after the initial flush, the Host rechecks caller, cancellation, eligibility, and revision immediately before appending `work/accepted`.

The receipt records `reviewedThroughSeq` and `actor: 'host-client'`. It does not invalidate itself; subsequent log facts do. A same-revision retry reuses the receipt, while a concurrent maintenance claimant may be refused. Success returns only after a durability barrier and a physical read confirms the receipt. Failure to receive success does not prove absence: a later retry can confirm an already-recorded receipt without appending another.

`workResults/get` captures one review cut before awaiting, flushes accepted work, and checks the physical receipt and stored tail covering that cut. It returns `verifiedThroughSeq` and whether the captured cut is still current, never promotes a later in-memory sequence into a durability claim. A raw projection is not proof of persistence. Clients verify only at quiet review points; streaming changes invalidate earlier confirmation without causing per-chunk flushes.

These are confirmations submitted by the existing trusted Host client, not cryptographic evidence of a physical human click. All endpoints are loopback-only under the existing Connection policy. Confirmation grants no agent permission, proves no test result, and does not attest unchanged files or a completed subagent tree.

## Content review

`workResults/recordContentReview` appends `work/reviewed`: a user decision bound to explicit `WorkContentVersion` identities (execution environment, source cut, locator, sha-256 digest of the bytes actually read, observation time) and `WorkCheckRecord` facts (checker identity, version and config digest, consumed version digests, exit code and verdict, durable log location, and evidence level `agent-claimed` | `host-captured` | `user-reviewed`). Every reference must resolve inside its own event. The durability barrier and physical re-read match the existing receipt path; a byte-identical resubmission reuses the latest record, and the same trusted-request fence applies.

Unlike `work/accepted`, the event names no log prefix and the record-confirmation policy is untouched: later log facts neither invalidate a content review nor mark it stale. `workResults/contentReview` reads the latest review with per-version currency. Without a fresh Host re-read, every confirmed version reports `not-reverified`; a caller holding a fresh host-side observation applies the pure comparison to report `matches-confirmed` or `changed-unreviewed` with the currently observed identity. This is explicit current-vs-confirmed separation, not a file watcher or a re-verification promise.

## Library and native opening

`workResults/list` returns bounded pages from a retained Session-corpus observation without activating agents or scanning device files. The first page captures normalized query, ordered Session identities and a query lifetime; continuations reuse each source inventory already observed. Live changes invalidate the query. External cold-store edits are not globally watched, so this is an observed corpus, not a claim that every source remained unchanged. Source positions, coverage omissions, and cursor expiry are explicit; see Retained Library observations below.

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

### Explicit content review

#### What the model sees

No new prompt, tool, or model-visible message. `work/reviewed` is log-only, like `work/accepted`.

#### Token effect

Zero additional model tokens.

#### KV Cache effect

Existing model-visible prefixes are unchanged.

## Known Limitations and Deferred Work

- Confirmation binds a Session log prefix, not file hashes. External file edits need not append events; resume bookkeeping can conservatively make a receipt stale without a new model turn.
- A content review binds declared digests, not device files. The read API reports `not-reverified` until an actual re-read; nothing watches files between reviews.
- Native opening requires Host-visible files. Remote execution worlds need their own export/locator adapter; this feature does not download or read remote output bytes.
- Library pages are bounded observations, not retained immutable corpus snapshots. Unavailable history and legacy uncaptured results are reported, and concurrent relevant changes can require retry.
- Host-client provenance inherits the existing loopback/browser trust boundary, not an independent authentication or physical-user attestation system.

## Passive Work and history reads

`inspect({sessionId})` returns independent Goal, execution, pending-interaction, record-review and registered-context-source observations. It uses Session Query and the existing Subagent catalog without resolving a cold Agent or claiming a lease. Ordinary forks remain distinct from delegation. Inactive or unavailable child execution is never promoted to success. Domain clocks remain separate: `source.current` only compares the addressed Session cut and runtime owner, while coverage lists missing runtime history and capped execution rows. Source descriptors are not a provider-health probe.

`history({sessionId, beforeSeq?, limit?, snapshot?})` returns bounded final message text with exact event positions. A source-prefix digest binds continuation pages; unrelated later appends may proceed, but replacement, repair or changed prefix content requires a new read. It does not claim to show reasoning, binary content or every log event, and bounding the rendered page does not bound the underlying persistence decode cost.

`review({sessionId})` performs the existing durability verification only for an already resident Agent. A cold record explicitly reports `runtime-unavailable` without activation. The older `get(agent)` endpoint remains for unmigrated clients; Product Shell uses `review`. Existing acceptance is still a Session-log confirmation, not a file-content or test attestation.

## Retained Library observations

The first page captures a bounded ordered Session corpus. Continuations reuse that observation and each source's first captured inventory; they do not relist or stat the entire corpus on every page. Live inventories use existing projections, cold sources use the existing projection cache when available, and fallback reads remain non-activating. Invalidation stays precise: Session creation or disposal, a result from a Session outside the retained corpus, or a result that actually changes an observed inventory (new captured path or uncaptured success) invalidates retained queries, while identical or failed outputs keep a valid page alive. External cold-store changes are not globally watched: these are retained observations, not immutable snapshots of every current file. Requery or cursor expiry obtains a fresh observation.

`maxLibraryQueries` defaults to 8, `libraryQueryTtlMs` to 120000, and `maxLibrarySessions` to 10000. Omitted Sessions are reported. `observedSessionIds` supports deduplicated coverage across path pages; existing page counts remain page counts. `maxExecutionEntries` defaults to 200, `maxHistoryRows` to 50, and `maxHistoryChars` to 64000. All new endpoints retain the exact trusted-request and loopback fences.
