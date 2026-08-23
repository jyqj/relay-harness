# `@deepseek-ai/dsh-issue-runner`

English | [中文](README.zh.md)

Service Definition for one published issue attempt. A run has a stable identity and Session, a never-rejecting terminal result, explicit cancellation, quiescent disposal, progress events, captured tracker tools, and orchestrator-owned continuation predicates.

## Model Experience

### Provider-owned issue run

#### What the model sees

The provider implementing `IssueRunner.start()` owns any model-visible request; this Service Definition emits none.

#### Token effect

The Service Definition emits no content.

#### KV Cache effect

A provider owns whether a run preserves or replaces its request prefix.

## Known Limitations and Deferred Work

- **One runner per realm** — deployment composition selects one execution mechanism for all issue attempts in that realm.
