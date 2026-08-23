# `@relay-harness/rlh-tracker-linear`

English | [中文](README.zh.md)

Linear GraphQL provider for `ctx.trackers`. It pages project-scoped candidate reads, batches exact-id reconciliation reads, normalizes labels/blockers/assignee routing, and captures a host-executed `linear_graphql` tool. The Linear token stays in the provider closure; the binding's token environment aliases are declarative metadata — child-process scrubbing is the subprocess seam's generic credential-shaped parent scrub and does not read this list.

## Model Experience

### Captured `linear_graphql` tool

#### What the model sees

One raw `linear_graphql` query/mutation tool when the issue runner installs this binding.

#### Token effect

The schema adds a fixed tool definition; results add the returned Linear JSON or a bounded error.

#### KV Cache effect

The captured schema is stable for the run. Switching provider bindings changes the tool prefix.

## Known Limitations and Deferred Work

- **Raw credential scope** — the tool can reach everything granted to the configured Linear token; workflow policy owns mutation discipline and idempotency.
- **No provider-side retry** — transport, HTTP, GraphQL, and pagination failures reach the orchestrator retry policy.
