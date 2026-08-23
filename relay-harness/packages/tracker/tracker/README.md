# `@relay-harness/rlh-tracker`

English | [中文](README.zh.md)

Provider registry for tracker reads and provider-native tools. Providers register through effects; polling resolves the current provider, while `bindTools()` captures one exact provider/configuration/tool snapshot plus credential-alias metadata for an agent run. Removing a provider blocks new work but does not revoke a captured binding.

## Model Experience

### Captured tracker binding

#### What the model sees

Indirectly, a runner may register the captured `TrackerToolSpec` values in an Agent scope.

#### Token effect

This package emits no prompt content. A Consumer decides when captured tool schemas enter a request.

#### KV Cache effect

The binding is stable for one run; a later capture may produce a different tool prefix.

## Known Limitations and Deferred Work

- **Provider choice is deployment policy** — the registry does not select among providers or merge their issue identities.
