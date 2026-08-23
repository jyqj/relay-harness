# `@deepseek-ai/dsh-issue-workflow`

English | [中文](README.zh.md)

Service Definition for one immutable repository-owned issue automation policy revision. Providers expose the current last-known-good snapshot and an explicit reload operation.

## Model Experience

### Captured policy revision

#### What the model sees

Indirectly, a Consumer renders `IssueWorkflowPolicy.promptTemplate` and `continuationTemplate`.

#### Token effect

This package emits no content; a committed revision applies only where its Consumer captures it.

#### KV Cache effect

A captured revision lets the Consumer keep an active prefix stable.

## Known Limitations and Deferred Work

- **No policy merge** — one provider owns one complete policy document per Cordis realm.
