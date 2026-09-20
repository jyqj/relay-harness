# Agent Note: A control-lost job reports as uncertain in WorkView, never inactive

Status: implemented

English | [中文](2026-09-20-work-view-control-lost-uncertain.zh.md)

## Problem

The WorkView execution join (`@relay-harness/rlh-host-work-results`, `work-view.ts`) mapped only `running`/`stopping` jobs to active-looking entries; every other job status — including `control-lost-unknown` — rendered as `activity: 'inactive'`, `recovery: 'history-only'`, and folded into an aggregate `execution.activity: 'idle'`. The job contract says the opposite: `control-lost-unknown` means the bounded stop elapsed without producer confirmation, so the work may still be running and the outcome is unknown, not negative. A user reading the Work page could conclude background work had stopped when it may not have — the exact misreading the `control-lost-unknown` status was introduced to prevent.

## Decision

- A job entry whose status is neither live (`running`/`stopping`) nor producer-confirmed terminal (`completed`/`killed`/`failed`) — in practice `control-lost-unknown` — reports `activity: 'unknown'` and `recovery: 'unknown'`, using the existing entry vocabulary, and gains no `outcome`. The detailed `recoveryCapabilities` are unchanged: control stays `none`, so the entry never claims residency.
- The aggregate rule already promotes any `unknown` entry, so `execution.activity` reports `'unknown'` whenever a control-lost entry exists. No new member was added to the `WorkExecutionEntry.activity`, `WorkExecutionEntry.recovery`, or `WorkView.execution.activity` unions, so the type-equiv documentation and clients that interpolate these values verbatim needed no change.
- The `runningJobs` confirmation blocker still counts only `running`/`stopping`. Log-prefix acceptance is a statement about the reviewed prefix, not about live background work.

## Alternatives considered

**A distinct `'uncertain'` activity value.** Rejected: the closed unions already carry `'unknown'` for exactly "not observable, cannot claim", at both entry and aggregate level; a new member would fork the vocabulary for the same meaning and force type, doc, and client updates with no added honesty.

**Reporting control-lost jobs as `running`.** Rejected: that claims the opposite positive fact, which the registry cannot confirm either. The honest value is the unknown.

**Also blocking confirmation while a control-lost job exists.** Rejected for now: acceptance records a reviewed prefix and never implies background jobs finished; widening the blocker set changes confirmation semantics without a current consumer asking for it.

## Consequences

- A Work page with a control-lost background job reads `unknown` activity and recovery with an aggregate `unknown`, instead of `inactive`/`history-only` and `idle`; the "not running" misrepresentation is gone.
- The `docs/subsystems/work-results.md`/`.zh.md` type-equiv blocks are unchanged because no union changed; ui-product-shell renders these values verbatim, so no locale key was added.
- A client that wants to distinguish "idle" from "uncertain" now must read the aggregate value honestly rather than treating everything non-running as inactive; that is the intended cost.
- Regression coverage: the work-results host spec starts a never-settling owned job, drives it to `control-lost-unknown` through the bounded stop, and asserts the entry and aggregate mapping through the trusted HTTP remote.
