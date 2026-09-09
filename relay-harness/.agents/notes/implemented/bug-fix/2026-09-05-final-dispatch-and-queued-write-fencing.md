# Agent Note: Recheck ownership at tool body admission and serialized writes

Status: implemented

English | [中文](2026-09-05-final-dispatch-and-queued-write-fencing.zh.md)

## Problem

A successful ownership check before an asynchronous wait does not authorize work after the wait. Tool guards ran before around-dispatch and resource acquisition, so an expired Activation lease could pass preparation and still enter a tool body before its renewal timer delivered cancellation. Persistence write-behind checked its Session fence before joining the per-id queue; a concurrent read could delay the append until after ownership changed. Initialization reads could similarly outlive ownership and then repair a stored tail.

## Decision

The [tool registry](../../../../packages/core/tools/src/index.ts) evaluates live monotonic guards after preparation and again while all resource locks are held, immediately before each body invocation. Final denial uses the same normalized error result as preparation denial and does not mark the body as started. Guards support repeated synchronous checks, including retry-wrapper invocations. A scoped guard replacement observed after preparation participates in final admission.

The [persistence coordinator](../../../../packages/session/session-persistence/src/coordinator.ts) rechecks a buffered Session's fence after its operation leaves the per-id queue. The common append implementation checks its exact live owner before calling the backend, covering direct service appends as well as buffered writes. Initialization revalidates ownership after asynchronous reads and before binding an owner or repairing a stored tail. The live controller captures its exact proof through `captureSessionPersistenceFence()` and retains it through batching, retry, and retirement, so retiring the Session fence cannot turn delayed checks into no-ops. Retirement also closes source-log append admission for the Session object; its lifetime proof cannot be replaced, and a successor uses a new Session. Failed checks leave undispatched mutations unwritten and buffered events subject to the same checks on retry.

A failed cold setup cannot return a lifetime-fenced Session to the prepared-source cache. Event-count equality is insufficient: a proof is installed without adding an event, and rollback retires it permanently. Releasing such a preparation discards its object graph; the next owner reloads a fresh Session rather than deleting or replacing the old proof. Unfenced unchanged preparations retain their existing reuse behavior.

## Alternatives considered

- Rely on lease-renewal cancellation: an event-loop pause can expire the lease before the cancellation timer runs; the final operation must check ownership itself.
- Check only before enqueue: an unrelated serialized read can delay storage dispatch beyond the owner's lifetime.
- Advertise atomic cross-process fencing from assertions alone: pre-dispatch checks cannot exclude takeover during asynchronous backend I/O. The separate [commit-exclusion decision](2026-09-05-persistence-commit-takeover-exclusion.md) supplies the shared mutation lock for Activation-owned persistence.

## Consequences

The [scoped-tool tests](../../../../packages/core/tools/tests/scoped.spec.ts) cover revoked around-dispatch admission and live guard replacement. The [resource-lock tests](../../../../packages/core/tools/tests/resource-lock.spec.ts) cover revocation while waiting and release of the acquired resource after denial. The [persistence tests](../../../../packages/session/session-persistence/tests/persistence.spec.ts) cover queued live flush, direct append to a live id, torn-tail repair after initialization-time ownership loss, and queued or retired writes after fence retirement, plus source-log closure and refusal to replace a Session's lifetime proof. These deterministic tests assert that no body or storage mutation starts after the failed ownership check; they do not claim exactly-once external effects or rollback of already-started operations. Ordinary successful transcript content is unchanged; existing runnable-application snapshots remain the normal-path evidence.

The independent takeover regressions use real JSONL and SQLite providers: a successor process commits its own turn before the stale queued writer resumes, and durable reads retain only the successor history. Failed fenced preparations also retry with fresh Session identities and successfully commit under successor leases in both backends.
