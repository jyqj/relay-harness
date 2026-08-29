# Packages

English | [中文](README.zh.md)

npm scope: `@relay-harness/rlh-*`; Cordis `Service` subclasses and function plugins contribute through `ctx.effect()`, `ctx.on()`, or `ctx.waterfall()`. Rules: [package](AGENTS.md), [root](../AGENTS.md#conventions).

## Hierarchy

Groups hold `packages/<group>/<pkg>/`; names stay `@relay-harness/rlh-<pkg>`. **Group READMEs own package/ctx-key maps.**

Every group ships as product with a stable API except five: `e2b/` is a POC, `experimental/` is unreleased, and `examples/`, `test-support/`, and `util/` are support infrastructure carrying lower compatibility expectations.

| Group | Role |
|---|---|
| [`core/`](core/README.md) | Product API spine: sessions, prompts, tools, agent services, and the concrete loop |
| [`api/`](api/README.md) | Remote BFF assembly and Typert RPC gateway |
| [`typert/`](typert/README.md) | Type graph generation, artifact loading, and runtime registry |
| [`goal/`](goal/README.md) | Same-session goal persistence and lifecycle |
| [`schedule/`](schedule/README.md) | Session-local scheduled follow-ups |
| [`feedback/`](feedback/README.md) | Human feedback |
| [`identity/`](identity/README.md) | Shared anonymous identity |
| [`llm/`](llm/README.md) | LLM capability family: the abstract service + provider adapters |
| [`e2b/`](e2b/README.md) | E2B providers |
| [`subprocess/`](subprocess/README.md) | Subprocess capability family: Service Definition + local process-tree provider |
| [`shell/`](shell/README.md) | Bash capability family: executor seam, local impl, model-facing tool |
| [`terminal/`](terminal/README.md) | Persistent PTY capability family: owner-scoped sessions, local implementation, and model-facing tools |
| [`code-runtime/`](code-runtime/README.md) | Code-execution capability family: Service Definition + worker-thread provider + Code Mode Consumer |
| [`sandbox/`](sandbox/README.md) | Process-confinement seam; bwrap/Landlock/Seatbelt backends |
| [`fs/`](fs/README.md) | Filesystem capability family: seam, local impl, model-facing file tools, bash-backed discovery tools |
| [`index/`](index/README.md) | Local code-index capability family: retrieval seam + SQLite-backed workspace indexer + model-facing search/status/refresh tools |
| [`lsp/`](lsp/README.md) | LSP capability family: seam, generic stdio provider, and the `lsp` tool |
| [`mcp/`](mcp/README.md) | Model Context Protocol bridges: client tool registration and the servers file |
| [`skill/`](skill/README.md) | Skill capability family: the provider registry, local provider, and model-facing catalog/loader |
| [`memory/`](memory/README.md) | Long-term-memory capability family: governed revisions, SQLite provider, Agent recall, and model-facing tools |
| [`compaction/`](compaction/README.md) | Compaction capability family: Service Definition + basic provider + command Consumer |
| [`context/`](context/README.md) | Model-visible request context, including workspace instructions and time context |
| [`subagent/`](subagent/README.md) | Subagent capability family: the provider-registry contract and the model-facing delegation tool |
| [`jobs/`](jobs/README.md) | Generic background-job runtime and model-facing `job_*` control tools |
| [`experimental/`](experimental/README.md) | Private prototypes and internal-only plugins |
| [`workflow/`](workflow/README.md) | Workflow seam, worker-thread engine, and model-facing `workflow`/`ralph` tools |
| [`web/`](web/README.md) | Web capability family: seam, search/fetch provider impls, and the model-facing web tools |
| [`attachment/`](attachment/README.md) | Durable attachment identity, validation, local content-addressed storage |
| [`spill/`](spill/README.md) | Spill capability family: storage seam, local impl, tool-result spill policy |
| [`todo/`](todo/README.md) | The model-facing `todo_write` tool |
| [`tracker/`](tracker/README.md) | Issue tracker capability family: provider registry and session-bound tools + the Linear provider |
| [`automation/`](automation/README.md) | Opt-in tracker-driven issue automation: orchestrator, runner, workspace, workflow, orchestration seams + their providers |
| [`plan/`](plan/README.md) | Plan collaboration state with a direct entry command and reviewed exit |
| [`preset/`](preset/README.md) | Per-session agent composition from preset `cordis.yml` files |
| [`guard/`](guard/README.md) | Loop-hygiene guards: advisory repeat-call reminders + the `tools/execute` deadline enforcer |
| [`bundle/`](bundle/README.md) | Installable `rlh --profile` patch layers |
| [`extensions/`](extensions/README.md) | Agent runtime self-modification: live plugin/service inspection and model-written plugin mount/unmount ([design](../.agents/notes/implemented/feature/2026-07-08-self-referential-cordis-toolset.md)) |
| [`hooks/`](hooks/README.md) | Hook bridges + the shared Claude Code / Codex wire-protocol library |
| [`session/`](session/README.md) | Durable session data plane: persistence seam + JSONL/SQLite backends, projection seam, log-backed titles, session reporting |
| [`session-query/`](session-query/README.md) | Session retrieval family: logical corpus, bounded reads, lineage, event relationships, semantic filtering, and SQLite full-text search |
| [`settings/`](settings/README.md) | User-settings seam + file-backed provider |
| [`credentials/`](credentials/README.md) | Credential-reference seam + env-over-`.env` provider |
| [`storage/`](storage/README.md) | Non-session storage hub + backends + domain form |
| [`workspace/`](workspace/README.md) | Workspace entity |
| [`sdk/`](sdk/README.md) | Out-of-process runtime SDK: JSON-RPC protocol, TypeScript client, and server plugin |
| [`acp/`](acp/README.md) | Automation-only Agent Client Protocol server |
| [`interaction/`](interaction/README.md) | Human-collaboration plane: approval/interaction seams, permission preset, commands, ask-user tool |
| [`boot/`](boot/README.md) | Shared app-bin boot glue |
| [`host/`](host/README.md) | Web-GUI host half: API gateway + HTTP route server |
| [`client/`](client/README.md) | Web-GUI browser half: shell, wire, object services, slots, `ui-*` plugins |
| [`examples/`](examples/README.md) | Demo bundles (agent-spine + CLI/ACP/JSON-RPC bins) leaves load |
| [`test-support/`](test-support/README.md) | Support infrastructure (testkits, invariants, replay, Loader smokes) |
| [`util/`](util/README.md) | Low-level zero-dependency utilities shared across groups (`Branded<B>`, Harness home/path helpers, timeout, retention) |

New packages join existing groups; new groups update their README and this table.

## Dependencies

The dependency graph is generated: [docs/module-graph.md](../docs/module-graph.md) (`pnpm run gen-module-graph`, freshness-gated in CI).

**Extension plugins depend on Service Definitions, never concrete providers.** `rlh-agent-loop` is swappable; UI, hook, and tool plugins use `rlh-agent`. Composition bundles, including `rlh-agent-spine-demo`, may depend on spine plugins. Capabilities separate Service Definition / Service Provider / Consumer roles when they evolve independently; see [capability seams](../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md).

Package READMEs cover purpose, APIs, extension points, and [Model Experience](../docs/cookbook/adding-a-package.md#4-write-the-package-readme) unless on the model-agnostic [omission allowlist](../scripts/verify-package-readme-model-experience.ts). They also carry `## Known Limitations and Deferred Work` or use its [allowlist](../scripts/verify-package-readme-limitations.ts).
