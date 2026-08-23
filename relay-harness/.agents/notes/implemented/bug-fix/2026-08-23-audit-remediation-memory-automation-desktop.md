# Agent Note: Audit remediation across memory, issue automation, and desktop

Status: implemented

English | [中文](2026-08-23-audit-remediation-memory-automation-desktop.zh.md)

## Problem

A four-track audit of the fork found: `tool-memory` accepted any successful tool result as `action-verified` evidence, so a model could launder `memory_search` output into an active entry; the memory feedback loop (`supersedes`/`supersededBy`, `usefulAccessCount`, `MemoryStatus 'superseded'`) had no writers; `enqueue`'s dedupe check-then-insert raced across processes; nothing detected a second process opening the same `memory.db`; context-budget truncation mixed UTF-16 code-unit and code-point lengths. The issue orchestrator redispatched completed-but-eligible issues with `attempt` reset to 1 and no bound; startup cleanup paged every terminal tracker issue and deleted directories for issues never claimed; due-retry and candidate dispatch fetched issues one id per GraphQL call; a tick failure could read config inside `catch` and silently stop polling; `fetchIssuesByIds` returned `[]` on malformed 200 responses. Desktop's `node --test` suite ran in no CI lane; the session-tree canvas fetched the full paged history of every session in the workspace on open; ~1,460 lines of QA walker shipped inside the installer asar; the primitives `Tooltip` had no Escape handling. Documentation gaps: `secretEnvironmentNames` was described as driving managed-child scrubbing with no runtime consumer; root `AGENTS.md` and `packages/README.md` omitted the `tracker/` and `automation/` groups.

## Decision

Evidence validation is shared: `dsh-memory` exports `memoryExcludesDerivedTool` (`memory_*`/`session_*`/`skill`), the extractor's local copy is removed, and `tool-memory` resolves each `tool/result` to its `tool/call` name so a derived or unpaired result cannot activate `action-verified`. Reviving a dead identity through `remember` writes the `supersedes`/`supersededBy` pair in one transaction; `forget` leaves no chain. `usefulAccessCount` increments inside the existing `BEGIN IMMEDIATE` read transactions, fail-open. `enqueue` moved its dedupe read and insert into one `BEGIN IMMEDIATE` transaction and returns the existing job on conflict. Schema version 3 adds a single-row `memory_store_owner` heartbeat (pid, boot id, timestamp): a fresh foreign heartbeat fails loud at startup, every write transaction refreshes and re-asserts ownership, and clean shutdown releases; `ownerStaleMs` is a validated Config field (default 30 s). Budget truncation counts code points everywhere.

The orchestrator's continuation path increments `attempt` without reset, backs off `min(continuationRetryMs × 2^(attempt-1), maxRetryBackoffMs)`, and stops at `maxContinuationAttempts` (validated policy field, default 5, 0 disables) by entering `blocked`, which the existing operator retry path already surfaces. Startup cleanup iterates only durable claim records and batch-fetches those ids; a provider never receives a delete for an unclaimed issue. Due-retry and candidate dispatch batch their exact-id reads per provider before capacity rechecks. The tick reads a non-throwing fallback interval before entering code that may fail; polling continues after repeated config failures. `fetchIssuesByIds` validates the `data.issues.nodes` chain and throws on malformed responses, matching `fetchIssuesByStates`. Dead `IssueOrchestrationError` codes are removed; `tracker-linear` default state sets live in one constant. The issue-automation bundle gains a REAL-composition test that boots the shipped `cordis.patch.yml` through the Loader with a memory tracker. Scrubbing prose now states the alias field is declarative metadata and the subprocess seam's credential-shaped `scrubbedParentEnv()` does the actual scrubbing.

`desktop-tests` is a `run-gates.ts` gate in `ci-primary`, `ci-static`, and `check-all`. The session-tree canvas opens with zero history requests: the graph renders stub cards from list metadata (`parentSessionId`/`seedLength`), full history loads per card on selection with a concurrency bound of 4 and AbortController cancellation, and prune keeps layout state for not-yet-loaded sessions. `build.files` excludes `release-ui-walk.js` and `composer-official-qa.js` from the asar; the packaged smoke helpers stay because `run-packaged-smoke.mjs` asserts their hits. `Tooltip` closes on Escape without moving focus. Layout and group tables list `tracker/` and `automation/`.

## Alternatives considered

**Wire `secretEnvironmentNames` into subprocess environment construction.** Rejected for this change: it crosses into the `dsh-subprocess` seam owned by the upstream layout; the declarative reading is documented instead.

**Add a `paused` terminal state for exhausted continuations.** Rejected: a new status would ripple into client UI and snapshot surfaces; `blocked` already means "operator must intervene" and is visible.

**Exclude the inline packaged smoke helpers from the asar.** Rejected: `run-final-gates.mjs` blocks the release on packaged smoke hit counts; removing them breaks the release gate. The ~1,460-line QA walkers are excluded instead.

**Track `lastAccessedAt` alongside `usefulAccessCount`.** Rejected: no consumer reads it; adding it would recreate a dead field.

**Emit `user_confirmed`/`user_rejected` signals.** Rejected: no user-facing review surface exists; fabricating a source would misstate provenance. The API stays, with READMEs noting it awaits a review surface.

## Verification

`packages/memory` 46 tests, `packages/automation` + `packages/tracker` + `packages/bundle/issue-automation` 104 tests, `packages/client/ui-session-tree` + `ui-primitives` 555 tests, and `apps/desktop` 649 node tests pass, including new cases for derived-evidence rejection, two-connection concurrent enqueue, fresh/stale owner heartbeat, exponential continuation backoff with the bound, batched fetch counts, polling survival after config failures, malformed `fetchIssuesByIds`, and canvas lazy loading. `run-gates.spec.ts` asserts the new gate's lane membership. Four Service Definition packages gained invariant companion tests. Full-repo typecheck and lint re-ran after the batch.

## Consequences

The audit's high-severity findings are closed or documented as deliberate: the vendored `dshmarket`/`dshbot` trees keep their tracked `node_modules/` (the offline installer design guarded by `dshmarket-preset.test.js`), now stated in `apps/desktop/vendor/README.md`. The session-tree canvas initially renders stub cards only; turn text and history search appear after a card is opened. Continuation-bounded issues require operator retry. The memory store remains single-owner; concurrent CLI/Web standard sessions fail loud at the second opener instead of silently sharing the database.
