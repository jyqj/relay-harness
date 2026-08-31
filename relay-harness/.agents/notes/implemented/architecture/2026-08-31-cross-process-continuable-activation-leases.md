# Agent Note: Cross-process continuable Activation leases

Status: implemented

English | [中文](2026-08-31-cross-process-continuable-activation-leases.zh.md)

## Problem

Durable child Sessions and mailboxes survived restart, but Activation ownership remained a process-local map. Two Harness processes sharing persistence could both cold-resume one child, execute turns, and append competing histories. A crash also left no bounded takeover point. Session persistence deliberately owns append-only logs, not live execution leases, so adding an unfenced boolean there would not solve stale-owner cleanup.

## Decision

`SubagentActivationLeaseStore` is a dedicated SQLite Adapter selected by `SubagentRuntime.activationLeasePath`. The shipped base uses `$RLH_HOME/subagent-activation-leases.sqlite3`; direct compositions may omit it to retain explicit single-process compatibility. Each child row carries a random owner token, monotonic integer fence, and epoch-millisecond expiry. `BEGIN IMMEDIATE` serializes acquisition: a live foreign row fails `ACTIVATION_LEASE_HELD`; an absent, released, or expired row advances the fence and becomes the new owner. Renewal, current-owner checks, and release compare child id, token, and fence, so a stale handle cannot renew or remove its successor.

The manager acquires before Agent creation and runs acquisition-phase renewal while asynchronous setup executes. The setup commit checks the exact token/fence immediately before registry publication; a post-create check covers the remaining return edge. A slow stale creator therefore disposes its unpublished handle and fails `ACTIVATION_LEASE_LOST`. Resident Activations renew periodically, assert ownership at pre-step and every follow-up, report, or interrupt admission, and cancel plus dispose on renewal failure. Disposal stops renewal and releases only the exact fence.

The child installs the same owner/fence as a `SessionPersistenceFence`. `Session.append()` rejects stale owners before changing the in-memory source log, and the first-party persistence coordinator rechecks before enqueue, flush, initialization completion, and serialized backend append. The child also registers a monotonic tool guard evaluated after approval and immediately before the tool body. A lease lost during approval therefore denies the side effect; lease loss during an active call cancels the Agent and uses the existing outcome-unknown record when the external system cannot prove whether it committed.

The defaults are a 30-second lifetime and 10-second renewal. Timing values and `now + leaseMs` must remain positive safe integers. A crashed process leaves the row untouched; takeover becomes legal only after its explicit expiry.

## Alternatives considered

**Reuse `withFileLock`.** Rejected because its intentional stale-lock policy never removes an unknown owner, so it cannot provide timed crash takeover.

**Put leases inside each Session backend.** Rejected because JSONL and SQLite have different topology, and a backend-specific optional method would fragment one ownership rule across every implementation. The dedicated database gives every persistence backend the same atomic CAS semantics.

**Delete a lock file based on age.** Rejected because age cannot distinguish a crashed process from a paused owner, and unlink lets a stale owner later remove a successor.

**Claim rollback of an already committed external effect.** Rejected. The owner fence now governs Activation publication, manager admissions, Session append/write admission, and tool-body admission, and renewal loss cancels active calls. No local mechanism can reverse a remote system that committed before observing abort; outcome-unknown recovery and domain reconciliation remain authoritative there.

## Testing

Store tests cover two owners, renewal, unexpired rejection, expiry takeover, monotonic fences, stale renew/release refusal, restart with an unreleased crash row, and safe-integer overflow. Integration tests prove a second runtime cannot materialize a leased child, a slow creator taken over during setup fails at the pre-publication commit without leaving a live Agent, a takeover during `tools/pre-execute` denies the tool body, and stale Session append/flush attempts never enter the durable backend.

## Consequences

With `activationLeasePath` configured, two valid Harness owners cannot publish the same continuable child concurrently, and a crashed owner can be replaced after a visible timeout. Healthy owners pay synchronous SQLite CAS work on acquisition/renewal/admission checks. Embedded deployments that omit the Adapter remain source-compatible but retain the documented single-process restriction. The fence now covers the local control, tool-start, Session append, and persistence-write planes; external systems remain separate transactions and require their ordinary reconciliation contract.
