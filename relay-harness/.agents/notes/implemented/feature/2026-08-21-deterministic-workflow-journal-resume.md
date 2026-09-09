# Agent Note: Deterministic workflow journal resume

Status: implemented

English | [中文](2026-08-21-deterministic-workflow-journal-resume.zh.md)

## Problem

A worker-thread workflow could run many expensive child calls but exposed only a live holder. Cancellation, process loss, or worker failure discarded every completed intermediate result; rerunning the script repeated all provider work and side effects. Saving only the final value did not help an interrupted run, while serializing arbitrary JavaScript heap state was neither portable nor compatible with the existing model-written script runtime.

Resume also cannot blindly trust call position. An edited or nondeterministic script might issue a different request at the same sequence and receive an unrelated old result. A durable journal must reject that divergence and must not accept unsafe, unbounded, partially written input.

## Decision

`WorkerThreadWorkflowEngine.Config.journalRoot` is an optional absolute directory. Omission preserves the stateless engine. When configured, a fresh run exclusively creates `<journalRoot>/<sha256(runId)>/journal.jsonl` with owner-only file mode before worker publication. `WorkflowStartRequest.resumeRunId` selects the existing run id; the engine rejects resume when no root is configured.

The versioned header carries the run id and a canonical SHA-256 fingerprint over script, validated meta, args, resolved subagent provider, and resolved total-agent cap. Loading the same run with any changed field fails synchronously with `JOURNAL_DIVERGENCE` before a worker starts.

Each worker `agent()` call has a deterministic one-based `callId`. The version-2 journal fsyncs an intent before provider startup, then fsyncs a terminal outcome before it is published to the worker. The intent carries the sequence and request hash; the outcome adds the published child id and detached result or stable failure. A terminal record requires its matching intent. Older journal formats are refused.

On resume, the script starts from its first statement. Matching terminal outcomes replay without provider work. A missing sequence begins a live suffix only after its intent reaches fsync. A matching unresolved intent fails with `JOURNAL_OUTCOME_UNKNOWN`, including after cancellation or a torn terminal append; a different request fails with replay divergence. Recovery requires inspecting possible side effects before explicitly starting a new run.

The journal is capped at 64 MiB. Restore accepts only a non-symlink regular file under that cap, validates every complete row and each intent-to-outcome transition, and truncates only a torn final JSON line. Calls may complete out of order; each sequence has at most one intent and one matching terminal outcome.

The model-facing `workflow` tool exposes optional `resumeRunId`, brands and forwards it, and never inspects storage or falls back to a fresh run. Every successful tool result already returns `runId`, which is the resume handle.

Recovery validates request ownership, every complete record, finite JSON results, and contiguous call sequences before fsyncing a final-line repair. A divergent request never modifies the file, and a missing earlier call never becomes a live suffix. The writer claim rejects both ordinary and dangling symlinks. Every child interruption, including cancellation caused by worker death, preserves the unknown-outcome intent.

## Alternatives considered

**Serialize the worker heap.** Rejected because Node vm promises, closures, realm objects, pending ports, and native handles have no lossless portable snapshot. Replay keeps the script as the state machine and stores only host-call facts.

**Journal only child ids.** Rejected because the script consumes text or structured results; reconstructing them from a disposed or remote child is not guaranteed.

**Replay by sequence without a request hash.** Rejected because edited or nondeterministic scripts would silently bind old results to new requests. The header catches static input changes and each call hash catches dynamic divergence.

**Record only terminal outcomes.** Rejected because a missing terminal record cannot distinguish an unstarted call from one whose external effects already happened. A durable intent cannot reconstruct a result, but it prevents automatic repetition of an unknown outcome. Exactly-once external effects still require provider idempotency or reconciliation.

**Record cancellation as a terminal call result.** Rejected because cancellation is an interruption, not a deterministic business outcome. The unresolved intent remains durable and prevents an automatic retry from repeating unknown side effects.

**Use one mutable JSON document.** Rejected because rewriting grows crash windows and memory with run size. Bounded append-only JSONL permits per-call fsync and final-tail repair.

**Allow relative journal paths or raw run ids in directories.** Rejected because cwd-dependent storage is not stable and caller-controlled ids can traverse. The configured root is absolute and the directory component is a fixed hex hash.

## Consequences

Completed child calls can be reused after cancellation or process restart without recontacting providers. Failure outcomes are deterministic too, and edited scripts fail loud rather than consuming stale values. The default base engine remains stateless because no deployment storage path is invented.

The journal prevents automatic repetition of calls with unknown outcomes; it does not roll back external effects or reconstruct arbitrary worker heap state. A run holds an exclusive SQLite writer transaction beside its journal before loading or repairing it. Competing hosts fail with `JOURNAL_BUSY`. The OS claim releases after worker exit and child quiescence; bounded disposal cannot release it while abandoned children remain active. Process death releases the lock without stale-pid deletion. The journal requires a local filesystem with reliable SQLite locking. Phase/log narration and local variables recompute during replay.

Worker-engine tests exercise terminal replay, cancellation with unresolved intent, divergence, append failure, unsafe files, torn-tail recovery, size bounds, and canonical hashes. Journal tests verify that a torn terminal append preserves the intent and that unresolved calls never replay as an unstarted suffix.

The [real-Loader recovery snapshot](../../../../examples/acp-agent/tests/workflow-recovery.snapshot.ts) boots the checked-in workflow fixture, executes one real spawn child with a scripted model, resumes through a second host without another model request, and refuses replay after a simulated torn terminal append. Its expected output retains the stable error message rather than machine-specific stack paths.

Request object keys use locale-independent UTF-16 code-unit ordering; array order remains significant. An English/Turkish locale subprocess regression prevents host collation from changing an otherwise identical request fingerprint.
