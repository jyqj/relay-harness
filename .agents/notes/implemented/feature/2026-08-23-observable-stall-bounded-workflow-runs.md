# Agent Note: Observable stall-bounded workflow runs

Status: implemented

English | [中文](2026-08-23-observable-stall-bounded-workflow-runs.zh.md)

## Problem

The workflow event stream exposed enough facts to build an external progress view, but the service itself retained no queryable active-run projection. Every operator integration had to rebuild ordering, phase, and child counts from listeners, and a duplicate durable run identity could begin while its earlier run was still live. A model-written workflow or remote child could also remain silent indefinitely; holder cancellation was bounded, but unattended deployments had no opt-in silence deadline.

## Decision

`WorkflowEngine` owns a process-local active-run table projected from the same `workflow/*` events it emits. `workflow/start` inserts one `WorkflowActiveRunSnapshot`; phase, log, and child lifecycle events advance its `lastProgressAt` and counters; `workflow/end` removes it before end listeners run. `activeRuns()` returns detached values in start order and exposes no live handle. `assertWorkflowRunAvailable()` makes an unmatched start a synchronous `RUN_ACTIVE` failure, and the worker-thread provider performs that check before journal access or worker construction.

`WorkerThreadWorkflowEngine.Config.stallTimeoutMs` is a non-negative deployment setting with default `0`. A positive value starts one run-owned watchdog and re-arms it after each accepted host/worker protocol message in either direction, including child publication and terminal result forwarding. Expiry atomically claims an error outcome, closes later protocol admission, aborts and disposes children, pairs stranded child lifecycle events, and terminates the worker. Accepted cancellation disarms the watchdog so the existing cancellation grace remains the only cancellation deadline.

The mechanisms are a clean-room adaptation of Symphony's single-owner runtime snapshot and last-progress stall reconciliation. No tracker adapter, Codex app-server client, workspace lifecycle implementation, or Elixir source enters the Workflow packages. The later [durable issue automation](2026-08-23-durable-issue-automation.md) decision implements those deployment concerns as independent opt-in capability seams rather than extending this engine.

## Alternatives considered

**Copy Symphony's tracker orchestrator into Workflow or Agent Loop.** Rejected because issue polling, provider-native ticket writes, and per-issue checkout policy are deployment concerns. Folding them into `agent-loop` or `workflow-worker-thread` would duplicate DSH Session, Subagent, Schedule, and Workspace ownership; the later opt-in automation layer preserves that separation.

**Expose the live `WorkflowRun` objects from the service.** Rejected because an observer would acquire cancellation and disposal authority. Detached facts preserve the existing holder-owned lifetime.

**Persist active-run snapshots.** Rejected because a process restart cannot resurrect worker threads or arbitrary script state. The existing workflow journal restores completed host calls; presenting its rows as live execution would be false.

**Enable a fixed watchdog by default.** Rejected because DSH has no universal upper bound for silent remote child work. Deployments opt in with a deadline larger than their longest expected protocol silence.

**Reset only on model-visible narration.** Rejected because child publication, result forwarding, and disposal acknowledgements are real forward progress even when the workflow emits no phase or log line.

## Verification

The workflow Service Definition tests pin start-order projection, timestamps, phase and child counts, detached nested meta, duplicate-id rejection, and removal at end. Worker-thread integration tests pin opt-in silence expiry as an error, active-projection removal, bounded disposal, and the unchanged disabled default through existing long-running cancellation cases. Typecheck, generated Cordis/config catalogs, bilingual pairing, and documentation gates cover the public method and config field.

## Consequences

Operator code can query current workflow facts without racing listener installation or gaining run control, and durable resume ids cannot run concurrently inside one engine. Unattended deployments can terminate silent workflows while interactive and long-running deployments retain prior behavior by leaving the watchdog disabled.

The projection is process-local and not a durable scheduler. `lastProgressAt` records accepted workflow lifecycle events, while the watchdog also treats private host/worker protocol traffic as progress; the operator timestamp is therefore intentionally a model-facing progress view rather than the watchdog's private timer sample. A configured timeout shorter than legitimate child silence will terminate useful work, so the provider README makes that deployment trade-off explicit.
