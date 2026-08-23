# Agent Note: Durable issue automation

Status: implemented

English | [中文](2026-08-23-durable-issue-automation.zh.md)

## Problem

DeepSeek Harness could run durable Sessions, subagents, jobs, schedules, and resumable workflow scripts, but it had no owner for continuously reading a tracker, claiming eligible work, preparing isolated issue directories, reconciling tracker changes, or exposing retry and blocked state to an operator. Putting that policy into `agent-loop`, Schedule, Workflow, or the existing Workspace registry would give a model-runtime component responsibility for an external business queue and duplicate an existing state owner.

## Decision

Issue automation is an opt-in layer of independent capability seams. `@deepseek-ai/dsh-tracker` registers effect-scoped providers and captures one provider/configuration/tool/credential-alias binding per run. `@deepseek-ai/dsh-issue-workflow-file` reads a repository Markdown/YAML policy, rejects an invalid startup document, and retains the last valid revision after reload failures. `@deepseek-ai/dsh-issue-workspace-local` owns deterministic paths, canonical containment, setup rollback, bounded hooks, and terminal removal without changing `WorkspaceRegistry`'s existing session-grouping contract.

`@deepseek-ai/dsh-issue-runner-agent` creates one native Agent Session in the prepared directory, installs the captured tracker tools before publication, and uses the same Session for bounded continuation turns while exact-id refresh says the issue remains eligible. `@deepseek-ai/dsh-issue-orchestrator` is the single scheduling writer. A storage-domain row commits `claimed` before workspace or Agent side effects and materializes `running`, `retrying`, or `blocked`; startup converts an interrupted claimed/running row into an immediate durable retry. Each poll reconciles running and blocked issues before candidate dispatch, revalidates every candidate by exact id, enforces global and state capacity, detects event silence, and applies bounded exponential backoff. Completed-but-still-eligible redispatches increment the attempt with exponential continuation backoff and stop at the configured bound in blocked state; startup workspace cleanup touches only issues with durable claim records. Live handles and timers are projections over the durable rows, not recovery facts.

The concrete first vertical slice is Linear. Its provider pages project-scoped candidate reads, batches reconciliation reads, normalizes routing facts, and exposes a session-bound host-executed `linear_graphql` tool without handing the token to the Agent. Generated Typert contracts expose snapshot, refresh, retry, and release. A browser plugin renders running, retrying, and blocked entries in a native titlebar/overlay contribution. `@deepseek-ai/dsh-issue-automation` composes the complete layer only when a deployment adds it after the Web bundle.

## Durable and security rules

Issue identity is provider-owned and branded. A record retains the provider and workflow revision that admitted the attempt. A tracker tool binding keeps advertisement and execution on the same captured provider. Local workspace creation and deletion revalidate canonical root containment; a reused directory is never destructively reset after setup failure. Tracker credentials remain in Host closures; providers declare environment aliases as declarative metadata, while managed-child scrubbing is the subprocess seam's generic credential-shaped parent-environment scrub, which that declaration does not drive. An operator may retry or release only non-running records; tracker reconciliation remains the ordinary authority for stopping live work.

## Alternatives considered

**Extend WorkflowEngine with tracker polling.** Rejected because Workflow executes one holder-owned script under one parent Agent, while issue orchestration owns an external queue, durable claims, and operator state across unrelated Sessions.

**Treat Schedule reminders as issue jobs.** Rejected because Schedule is agent-scoped and event-sourced inside one Session. A tracker claim must exist before any Agent Session and remain meaningful after that process is gone.

**Reuse WorkspaceRegistry as a directory provisioner.** Rejected because that service durably groups existing canonical directories and Sessions but intentionally does not create, populate, reset, or delete repository contents.

**Port Symphony's Elixir service or app-server client.** Rejected because Cordis effects, DSH Agent/Session, Tool Runtime, subprocess trees, storage domains, generated Remotes, and native client slots already own those mechanisms. Only behavior and invariants were adapted; no Elixir source or independent transport enters the runtime.

**Keep claimed, retry, and blocked state in memory.** Rejected because a host restart would silently release work and lose operator intervention. Durable rows make recovery explicit without pretending a process or model stream survived.

**Ship every tracker adapter at once.** Rejected because a complete Linear slice proves the provider seam, host-tool snapshot, credential handling, reconciliation, and pagination. Additional providers should preserve their native semantics rather than conform to a shallow CRUD abstraction.

## Verification

Tracker tests pin effect disposal, captured binding survival, unsupported-tool failure, schema validation, Linear pagination, routing normalization, host auth, transient viewer lookup recovery, and bounded failures. Workspace tests execute real managed hooks and pin one-time setup, reuse, rollback, collision-safe keys, and symlink escape rejection. Workflow tests pin typed parsing, strict failures, revision changes, and last-known-good reload. The native runner test drives the real Agent Loop through a captured tracker tool and two continuation turns. Orchestrator tests pin durable claim-to-run publication, terminal cleanup, blocked persistence, operator retry, and refresh coalescing; the bundle's REAL-composition test boots the shipped patch through the Loader over a memory tracker stub. Generated Typert output, Host/Client type faces, bundle configuration validation, package invariant companions, native client slot/component tests, and bilingual documentation gates cover the remaining integration surfaces.

## Consequences

The harness can operate a repository-owned issue queue without weakening the Agent Loop or duplicating Session state. A crash loses live process state but preserves why work was claimed, where it ran, which attempt follows, and whether an operator must intervene. In-run continuation keeps one model prefix, while host recovery starts a fresh Session over the preserved workspace instead of presenting false continuation.

The layer adds several packages because tracker, policy, workspace, execution, scheduling, transport, and presentation evolve independently. The shipped scheduler is single-host; active/active operation needs a later storage provider with compare-and-set leases. The Linear raw tool intentionally carries the configured token's native reach, so deployment policy remains responsible for allowed mutations and provider-side idempotency.
