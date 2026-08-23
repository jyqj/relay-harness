# `@deepseek-ai/dsh-issue-automation`

English | [中文](README.zh.md)

Opt-in bundle layer applied after `dsh-base` and `dsh-web-app`. It composes the tracker registry and Linear provider, repository workflow file, local issue workspace, native multi-turn Agent runner, durable orchestrator, generated Remote namespace, and browser operator overlay. The layer is not part of the stock Web profile because it requires an explicit workflow path, tracker scope, credential, and isolated workspace policy.

## Model Experience

### Composed issue run

#### What the model sees

Indirectly, the bundle composes `promptTemplate`, continuation messages, and the captured `linear_graphql` tool described by its component packages.

#### Token effect

The component packages own task-sized prompts and the fixed tracker tool schema.

#### KV Cache effect

One active issue run keeps a stable Agent Session prefix; host retries create a new prefix over the preserved workspace.

## Known Limitations and Deferred Work

- **Linear vertical slice** — the provider seam is generic, but this bundle intentionally ships one complete tracker integration rather than shallow adapters for every vendor.
- **Single-host scheduler** — use only one active orchestrator against a tracker scope until a distributed lease provider exists.
