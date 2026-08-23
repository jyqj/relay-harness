# `@deepseek-ai/dsh-client-ui-issue-orchestration`

English | [中文](README.zh.md)

Operator overlay for the Remote issue orchestration snapshot. A titlebar badge opens running, retrying, and blocked cards; operators can refresh, retry, release, and open a linked Session. The observable source is owned in `apply`; components receive it through the slot renderer's injected hook.

## Model Experience

### Operator overlay

#### What the model sees

Nothing; `shell.overlay` renders Host orchestration state for a human operator.

#### Token effect

Zero direct tokens.

#### KV Cache effect

No request prefix changes.

## Known Limitations and Deferred Work

- **No cancellation button for running work** — tracker reconciliation remains the normal stop authority; explicit operator cancellation awaits a distinct Host command and policy.
