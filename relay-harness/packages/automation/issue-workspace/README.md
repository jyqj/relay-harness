# `@deepseek-ai/dsh-issue-workspace`

English | [中文](README.zh.md)

Service Definition for deterministic per-issue workspace lifecycle: locate without mutation, create/reuse, attempt-blocking `beforeRun`, best-effort `afterRun`, and terminal removal.

## Model Experience

### Prepared working directory

#### What the model sees

Indirectly, the runner executes with `IssueWorkspace.path` as its working directory.

#### Token effect

No direct request content.

#### KV Cache effect

The workspace seam does not change a request prefix.

## Known Limitations and Deferred Work

- **VCS policy is provider-owned** — cloning, checkout, reset, and dependency setup belong to provider hooks or a future VCS-specific provider.
