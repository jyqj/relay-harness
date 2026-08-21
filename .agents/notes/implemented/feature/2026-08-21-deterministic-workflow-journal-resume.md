# Agent Note: Deterministic workflow journal resume

Status: implemented

English | [中文](2026-08-21-deterministic-workflow-journal-resume.zh.md)

## Problem

A worker-thread workflow could run many expensive child calls but exposed only a live holder. Cancellation, process loss, or worker failure discarded every completed intermediate result; rerunning the script repeated all provider work and side effects. Saving only the final value did not help an interrupted run, while serializing arbitrary JavaScript heap state was neither portable nor compatible with the existing model-written script runtime.

Resume also cannot blindly trust call position. An edited or nondeterministic script might issue a different request at the same sequence and receive an unrelated old result. A durable journal must reject that divergence and must not accept unsafe, unbounded, partially written input.

## Decision

`WorkerThreadWorkflowEngine.Config.journalRoot` is an optional absolute directory. Omission preserves the stateless engine. When configured, a fresh run exclusively creates `<journalRoot>/<sha256(runId)>/journal.jsonl` with owner-only file mode before worker publication. `WorkflowStartRequest.resumeRunId` selects the existing run id; the engine rejects resume when no root is configured.

The versioned header carries the run id and a canonical SHA-256 fingerprint over script, validated meta, args, resolved subagent provider, and resolved total-agent cap. Loading the same run with any changed field fails synchronously with `JOURNAL_DIVERGENCE` before a worker starts.

Each worker `agent()` call already has a deterministic one-based `callId`. After a live child reaches one terminal host outcome, the host fsyncs one JSON line containing the call sequence, canonical request hash, child id when published, and either the detached child result, start error, or infrastructure failure. Only after append succeeds does the host publish that outcome to the worker. Append failure becomes a fatal child infrastructure error; it never lets the script continue with an unrecorded result.

On resume, the script starts from its first statement. A journal entry whose sequence and request hash match is replayed through the existing `child-started` plus terminal protocol without provider work; the worker therefore emits the same paired member lifecycle and computes later script values normally. A recorded start or result failure replays as the same failure. A missing entry marks the live suffix and starts a real child. A mismatched hash fails the run with replay divergence. Cancellation and other host teardown do not record an unfinished suffix, so later resume retries it.

The journal is capped at 64 MiB. Restore accepts only a non-symlink regular file under that cap, validates header and every complete row, rejects duplicate sequences and malformed outcomes, and truncates only a torn final JSON line. Calls may complete out of order, so physical JSONL order need not equal call order; sequence keys remain unique and replay is indexed by call id.

The model-facing `workflow` tool exposes optional `resumeRunId`, brands and forwards it, and never inspects storage or falls back to a fresh run. Every successful tool result already returns `runId`, which is the resume handle.

## Alternatives considered

**Serialize the worker heap.** Rejected because Node vm promises, closures, realm objects, pending ports, and native handles have no lossless portable snapshot. Replay keeps the script as the state machine and stores only host-call facts.

**Journal only child ids.** Rejected because the script consumes text or structured results; reconstructing them from a disposed or remote child is not guaranteed.

**Replay by sequence without a request hash.** Rejected because edited or nondeterministic scripts would silently bind old results to new requests. The header catches static input changes and each call hash catches dynamic divergence.

**Record before child execution.** Rejected because an intent record cannot supply the terminal value after restart. Exactly-once external side effects require provider idempotency; this journal guarantees replay only after the terminal outcome reaches fsync.

**Record cancellation as a terminal call result.** Rejected because cancellation is an interruption of the run, not the child request's deterministic business outcome. Leaving the suffix absent lets resume retry useful work.

**Use one mutable JSON document.** Rejected because rewriting grows crash windows and memory with run size. Bounded append-only JSONL permits per-call fsync and final-tail repair.

**Allow relative journal paths or raw run ids in directories.** Rejected because cwd-dependent storage is not stable and caller-controlled ids can traverse. The configured root is absolute and the directory component is a fixed hex hash.

## Consequences

Completed child calls can be reused after cancellation or process restart without recontacting providers. Failure outcomes are deterministic too, and edited scripts fail loud rather than consuming stale values. The default base engine remains stateless because no deployment storage path is invented.

The design is at-least-once around the narrow crash window between an external child effect and journal fsync. It is single-process/single-writer: two hosts must not resume the same run concurrently until a durable lease protocol exists. Phase/log narration and arbitrary local variables recompute during replay; only host-call outcomes are durable.

Worker-engine tests cover settled, start-error, result-error and unserializable-result replay; cancellation retry; script and call divergence; append failure; unsafe files; final-tail repair; bounds; canonical hashes; and every journal validation branch. The worker-thread source retains per-file 100% statements, branches, functions, and lines.
