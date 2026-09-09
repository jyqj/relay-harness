# Agent Note: Confirm durable Session result records and search their outputs

Status: implemented

English | [中文](2026-09-05-session-result-confirmation-and-library.zh.md)

## Problem

A model declaring its goal complete is not user confirmation, and a tool success is not verification. A current-page output list also omits older and cold Session results. Treating an appended receipt as durable lets a failed flush appear successful in another tab or after remounting; resolving an output against the currently selected workspace can open the wrong file.

## Decision

The [Host work-results adapter](../../../../packages/host/work-results/README.md) owns pure output and confirmation projections over the existing Session log. It creates no parallel Work state store. `work/accepted` records the reviewed non-acceptance sequence and `actor: 'host-client'`; confirmation does not change goal phase, grant tool permissions, or assert test success. The existing Agent maintenance transaction owns the action, with caller, quiescence, pending-interaction, and revision checks repeated immediately before append. A same-revision retry reuses its receipt, and a conflicting maintenance action is refused.

The [Gateway](../../../../packages/api/gateway/src/index.ts) exposes only the active original trusted Connection request, invalidates it in `finally`, and does not create provenance for direct invocation. The adapter checks the exact original endpoint and rejects an agent initiator. Nested endpoints and escaped callbacks cannot borrow a completed request. All Work endpoints use the existing loopback-only transport policy. This is trusted Host-client provenance, not proof of a physical human gesture or a new authentication scheme.

Confirmation success requires a physical read of the persisted receipt after flush. The verified read captures its cut before awaiting and confirms the corresponding stored receipt and tail; later memory events only make its `current` flag false. [Work UI](../../../../packages/client/ui-product-shell/src/client/WorkPage.tsx) never promotes raw projection arrival into saved confirmation. It verifies at quiet review points, invalidates on changed facts, respects a superseded response, and contains cancelled or late requests. Streaming updates do not trigger per-chunk verification or publish otherwise unchanged Work facts.

Library queries use bounded non-activating Session reads and report scan coverage, unavailable history, and uncaptured legacy results. Cursor identity includes the query, Session order, live output projections, and cold storage revisions; relevant changes reject continuation instead of losing new outputs in already-scanned Sessions. Output opening remains one Host request: verify the exact recorded candidate, resolve its source-relative path, observe its canonical target again before dispatch, then invoke the existing native opener. The original opener owns permission and refusal. A cwd-only rule is not an authorization model: legitimate external files and introduced symlinks remain supported.

## Alternatives considered

- Let `goal.complete` or successful tools mark user confirmation: both confuse execution claims with an external client's explicit confirmation.
- Publish a receipt and rely on one component's local error state: another tab or remount would read the same unflushed event and incorrectly display success. The shared Host verification proves a concrete persisted cut instead.
- Keep a second Work database or copy live projection state into a client authority: either can disagree with replay and Session recovery. Query responses are presentation snapshots, while the log and persistence owner remain authoritative.
- Infer open permission from cwd containment: existing explicit files, temporary outputs, and symlinks can be legitimate outside that directory. Recorded paths are provenance, while native opening retains its original authority.

## Consequences

The [Host tests](../../../../packages/host/work-results/tests/host.spec.ts) boot a `cordis.yml` through app-boot and Loader, call real HTTP Remote endpoints, exercise JSONL restore and SDK JSON-RPC framing, and check conflict, failed durability, nested/direct/agent calls, bounded Library pages, cursor invalidation, source identity, external files, and target changes. [Component tests](../../../../packages/client/ui-product-shell/tests/pages.client.spec.tsx) cover explicit confirmation and paging. The independently authored [review regressions](../../../../packages/client/ui-product-shell/tests/review-regressions.client.spec.tsx) cover failed-save remounts and multiple views, superseded responses, cancelled verification on Session switches, pending native opens across collapse/reexpand, and stale errors after a query change.

The confirmed object is a Session log prefix, not file content hashes or completion of every continuable child. External file editing need not append a Session event. Resume bookkeeping can conservatively invalidate an old receipt without a new model turn. File paths remain mutable locators; operation-local target-change detection is not immutable file identity. Library revision checks can require retry while the relevant corpus changes. Source and component evidence do not substitute for built-browser, platform-matrix, or real-provider runs.
