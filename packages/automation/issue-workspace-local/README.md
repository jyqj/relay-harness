# `@relay-harness/rlh-issue-workspace-local`

English | [中文](README.zh.md)

Local provider that derives a sanitized collision-resistant directory key, canonicalizes the root and target, rejects symlink escape, preserves reused workspaces, removes failed new setup, and runs bounded hooks through `ctx.subprocess` with issue metadata in explicit `RLH_*` environment fields.

## Model Experience

### Local workspace contents

#### What the model sees

Indirectly, files created by `afterCreate` and `beforeRun` are available to the runner's tools.

#### Token effect

No direct request content.

#### KV Cache effect

The provider does not change a request prefix.

## Known Limitations and Deferred Work

- **Trusted hooks** — hook strings are deployment code executed by a shell; this provider bounds them but does not sandbox their semantics.
- **Local execution world only** — remote workers require a provider that validates containment in that remote filesystem.
