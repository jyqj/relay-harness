# `@deepseek-ai/dsh-issue-orchestrator`

English | [中文](README.zh.md)

Durable single-writer scheduler. Each tick reloads last-known-good policy, reconciles running and blocked issues before dispatch, revalidates every candidate by id, enforces global and per-state capacity, persists claim before workspace or Agent side effects, detects event silence, applies bounded exponential retry, preserves blocked state, and recovers interrupted host runs as queued retries.

The storage-domain record is authoritative across restart. Live handles and timers are projections: a restart does not pretend to resume an unknown process, but it also does not forget the claim, workspace, attempt, or blocker.

## Model Experience

### Dispatch-owned model work

#### What the model sees

The captured `IssueWorkflowPolicy` and selected `IssueRunner` determine the model-visible work; this scheduler emits none itself.

#### Token effect

No direct content; the selected Consumer owns task and continuation tokens.

#### KV Cache effect

Retrying starts a fresh Session, while in-run continuation preserves its Session prefix.

## Known Limitations and Deferred Work

- **Single process authority** — durable state survives restart, but multi-host active/active scheduling requires a lease backend with compare-and-set ownership.
- **No dead-letter terminal state** — repeated failures remain bounded-backoff retries until tracker policy or an operator releases them.
