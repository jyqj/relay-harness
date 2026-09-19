# @relay-harness/rlh-host-plugin-inventory

English | [中文](README.zh.md)

Read-only Host projection of the current Cordis Loader tree. `PluginInventoryGateway` registers the `pluginInventory` service and publishes two generated direct Remotes, `pluginInventory/list` and `pluginInventory/capabilities`. Every call reads `ctx.loader.entries()` directly, skips structural group rows, and returns the remaining entries in Loader order with only their Loader entry id, module specifier, effective enablement, and current root Fiber phase.

The phase is `pending`, `loading`, `active`, `failed`, or `unloading`; it is `null` when the entry has no live root Fiber. The snapshot is intentionally point-in-time: Loader remains the sole lifecycle authority, while this package owns no cache, history, provenance model, event stream, or mutation path. Its public payload types live under `./types`, and Typert generates the Host and Client Remote artifacts exposed by `./typert` and `./remote`.

`pluginInventory/capabilities` joins the mounted Loader tree, the host's tool registry, and the shipped capability catalog (`DEFAULT_CAPABILITY_CATALOG`) into one effective-capability report: per capability, an `assembled` / `configured` / `healthy` / `session-available` verdict plus evidence naming where each fact came from, and a folded `effective` state. The fold is honest by construction — `installed` never becomes `healthy` or `running`, so a mounted code-index router without an embedding endpoint reports `installed`, not `running`. The same `buildCapabilityReport` builder over the same catalog backs the boot-free `rlh --dump-capabilities` CLI dump, whose composed-only evidence reports the runtime levels as `unknown`.

The service is Remote-only and deliberately declares no same-process Cordis `Context` merge. Client packages consume it through the explicit [`api-remotes`](../../api/remotes/README.md) assembly rather than importing the Host implementation.

## Model Experience

None, as this Host-only inventory projection registers no prompt, tool, message, or provider request.

#### KV Cache effect

None; this package never assembles model input.

## Known Limitations and Deferred Work

- **Point-in-time state only** — the result contains no durable failure history or subscription; a missing root Fiber is reported as `null`, regardless of why no live root exists.
- **No provenance or mutation** — the service does not identify which bundle, profile, or override introduced an entry, and it cannot enable, disable, add, or remove plugins.
- **Catalog is a fixed allowlist** — the report covers only the capabilities `DEFAULT_CAPABILITY_CATALOG` declares; the session level reads the host's global tool registry, not a per-session scoped toolset, and preset-gated context contributions (memory, code recall) are not yet modeled.
