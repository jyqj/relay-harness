# `@deepseek-ai/dsh-issue-orchestration`

English | [中文](README.zh.md)

Remote-capable Service Definition for operator snapshots and commands over durable issue automation. Snapshots separate running/claimed, retrying, and blocked entries; `refresh`, `retry`, and `release` are explicit commands.

## Model Experience

### Operator state

#### What the model sees

Nothing; `ctx.issueOrchestration` is an operator/query service.

#### Token effect

Zero direct tokens.

#### KV Cache effect

No request prefix changes.

## Known Limitations and Deferred Work

- **Provider owns authorization** — the Service Definition does not decide which transport principals may invoke operator commands.
