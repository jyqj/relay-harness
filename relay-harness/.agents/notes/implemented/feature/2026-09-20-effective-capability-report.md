# Agent Note: Effective capability reporting across composition, config, runtime, and session

Status: implemented

English | [中文](2026-09-20-effective-capability-report.zh.md)

## Problem

"Installed", "configured", "healthy", and "session-available" are different facts, but no surface joined them. `rlh --dump-config` prints raw patch layers per bundle, and `pluginInventory/list` reports Loader-level enablement and fiber phase; neither can answer whether semantic search, web search, or full-text session search is actually usable in a given deployment or session, and nothing distinguished an unconfigured capability from a broken one.

## Decision

`@relay-harness/rlh-host-plugin-inventory` owns one report builder, `buildCapabilityReport`, and one shipped capability catalog (`DEFAULT_CAPABILITY_CATALOG`). Per capability the report carries four evidence-backed levels — `assembled` (composed bundle entry list), `configured` (composed entry config, evaluated by per-capability predicates), `healthy` (Loader fiber state), `session-available` (the host tool registry) — each with `yes`/`no`/`unknown` plus an evidence string naming where the fact came from, and a folded `effective` state (`absent`/`installed`/`standby`/`running`) whose fold never forwards `installed`.

Two surfaces share that builder. `pluginInventory/capabilities` reads the mounted Loader tree itself as the composed evidence (config already evaluated), so a booted host reports every level. `rlh --dump-capabilities` reuses the config-dump composition (user layers and `--patch` overlays included, `!!js` expressions unevaluated) and reports the runtime levels as `unknown`, printing a note that says exactly that; requirement predicates read literal values only and treat expressions as unmet rather than guessing.

The initial catalog covers code-index (embedding endpoint required; the `baseURL`/`model` off switch of `resolveEmbeddingConfig` is the configured predicate), web search (`apiKeyEnv` set), and full-text session search (`openAt` not `never`).

## Alternatives considered

**Boot the profile for a full CLI report.** Dump modes exist to be boot-free and side-effect free; booting to print a report would change what the flag costs and break the recovery path for a broken patch file. The honest `unknown` plus the booted remote keeps both contracts.

**Deriving requirements from plugin Config schemas generically.** Schemas state validity, not deployment intent: "embedding absent" is a legal, meaningful off state, not a validation failure. Declaring per-capability requirements in one catalog keeps the off-switch semantics with the report instead of encoding them into a schema walker.

**A new capability-report package.** The builder, catalog, and the reading Remote all live in the inventory package that already projects Loader state; the CLI already depended on it, and a second projection home would split the vocabulary.

## Consequences

The catalog is a fixed allowlist: capabilities it does not declare are invisible to the report, and the session level reads the host's global tool registry rather than a per-session scoped toolset, so preset-gated context contributions (memory, code recall) are not modeled. A deployment that mounts a capability under an unexpected entry id reports `absent` until the catalog names that id. `pluginInventory` gained a type-only peer dependency on `@relay-harness/rlh-tools` for the tool-registry read, and the gateway stays mountable where `tools` is absent by reporting that level `unknown`. Adding a catalog entry requires no SDK regeneration: Typert regenerates the Remote artifacts at build.

The `composeEntriesWithProvenance` export in `@relay-harness/rlh-app-boot` now owns the config-dump composition loop that `renderConfigDump` renders; its provenance labels feed the CLI report's assembled evidence.

## Verification

Builder unit tests cover every level across composed-only, booted, failed-fiber, disabled, and missing-toolset inputs, including the installed-never-runs fold property. Gateway tests assert the second Remote method and mounted-Loader evidence; CLI tests cover argument routing and a real web-profile composition through the shared builder. Targeted `tsc -b` on the touched packages passes; assembled-application snapshot coverage was not extended because the dump and Remote add no model-visible behavior.
