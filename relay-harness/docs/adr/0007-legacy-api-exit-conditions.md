# ADR-0007: Transitional API Paths Carry Checkable Exit Conditions

English | [中文](0007-legacy-api-exit-conditions.zh.md)

- **Status:** Accepted
- **Date:** 2026-09-20

## Context

The API-layer migration leaves two client-facing method surfaces. The Typert remote assembly (`@relay-harness/rlh-api-remotes`) mounts generated `/remote` contributions as `ctx.remote.<namespace>` methods; the API proxy (`packages/host/apiproxy`) serves `RpcMethodMap` methods under `/api`. While a business domain answers on both, each surface can grow its own business rules, and nothing notices when the transitional second surface becomes permanent.

## Decision

1. A domain exposed on both surfaces is transitional. It exists only with a row in the table below naming its rule owner, the live consumers of each surface, the migration target, and a mechanically checkable exit criterion.
2. Duplication never survives "for compatibility" without such a row. The checkable invariants run through [scripts/legacy-api-exit.ts](../../scripts/legacy-api-exit.ts) as a vitest spec (`scripts/legacy-api-exit.spec.ts`, part of `pnpm run test`): the set of duplicated domains must equal the recorded allowlist, every remote contribution mounted by the client assembly must appear in the remote-wire table, and `PRIVILEGED_METHODS` in [packages/client/connection/src/index.ts](../../packages/client/connection/src/index.ts) must match the pinned method list.
3. Migrating a domain deletes the losing surface and removes its allowlist entry in the same change. A stale allowlist entry fails the guard, so an exit is enforced rather than remembered.

### Duplicated domains

| Domain | Rule owner | Remote surface (`ctx.remote.*`) | API-proxy wire surface (`/api`) | Exit criterion |
|---|---|---|---|---|
| goals | `packages/goal/goal` — the Cordis `goals` service owns goal phase and compare-and-set rules | `ctx.remote.goals.*` via `rlh-goal/remote`; consumed by `packages/client/ui-goal` and the web client assembly | `goal.create`/`edit`/`pause`/`resume`/`complete`/`clear` in `packages/host/apiproxy`; product clients do not call them — only the connection test fixture and apiproxy tests do | `RpcMethodMap` declares no `goal.*` key and [packages/host/apiproxy/src/api/goals.ts](../../packages/host/apiproxy/src/api/goals.ts) is deleted, with the guard's allowlist entry removed in the same change |
| skills | `packages/skill/skill` (registry) and `packages/host/skill-inventory` (file CRUD) own the catalog; both surfaces delegate to them | `ctx.remote.skillInventory.*` via `rlh-host-skill-inventory/remote`; consumed by `packages/client/ui-settings-skills` in the browser through the loopback fence | `skill.list`, a read-only per-session catalog consumed by `packages/client/ui-skill` for the composer picker | `ui-skill` reads the catalog through the remote surface, then `skill.list` is removed from `RpcMethodMap` and [packages/host/apiproxy/src/api/skills.ts](../../packages/host/apiproxy/src/api/skills.ts) is deleted |

### Browser-trust fence re-exposure

`packages/client/connection/src/index.ts` pins `PRIVILEGED_METHODS` to loopback and re-exposes the remote-tunnel groups `mcpServers/*`, `skillInventory/*`, and `workResults/*` to browser packages (`ui-settings-mcp`, `ui-settings-skills`, and the work-results views). The guard pins the exact method list, so the fence shrinks only through a deliberate list change, and a domain that stops using the fence must leave the pinned list.

### New duplication

Adding an API-proxy handler for a domain that the remote assembly already mounts fails the guard until the remote-wire table and the allowlist record the decision, with a status row here or in the owning migration plan.

## Consequences

- The duplicated set is reviewable in one allowlist, and drift fails `pnpm run test` instead of waiting for an audit.
- Exits are enforced mechanically: deleting a surface without retiring its allowlist entry is a test failure, and so is keeping a method on the fence without pinning it.
- The remote-wire table makes future duplication opt-in: a new remote contribution must join the table, which forces its owner to state whether an API-proxy counterpart may exist.
- The guard reads source text only, adding no build step and no runtime behavior.
