# context/ — request-context extensions

English | [中文](README.zh.md)

Product plugins that add model-visible request context without defining a tool. `agent-instructions` is included by the default `rlh-agent-spine-demo` bundle and can be disabled through bundle config. The base bundle composes `context-engine` and the purpose-specific Session History provider; Web adds Prompt Enhancement with its Context Engine and LLM adapters plus file-reference discovery. The remaining packages are opt-in.

| Package | Role | ctx key |
|---|---|---|
| [`context-engine/`](context-engine/README.md) | Step-context contributor registry and the evidence protocol seam | `ctx.contextEngine` |
| [`session-history-context/`](session-history-context/README.md) | Bounded durable current-Session history for Prompt Enhancement | `ctx.sessionHistoryContext` |
| [`session-reference/`](session-reference/README.md) | Bounded snapshots of other sessions | `ctx.sessionReferenceResolver` |
| [`file-reference/`](file-reference/README.md) | File-reference discovery seam and `@file` grammar | `ctx.fileReferences` |
| [`file-reference-local/`](file-reference-local/README.md) | Local-filesystem file-reference provider | — |
| [`code-context/`](code-context/README.md) | Code-index recall contributor over `ctx.codeIndex` | `ctx.codeContext` |
| [`prompt-enhancement/`](prompt-enhancement/README.md) | Prompt Enhancement service, provider lifecycle, and Remote | `ctx.promptEnhancement` |
| [`prompt-enhancement-context-engine/`](prompt-enhancement-context-engine/README.md) | Adapter over the shared Context Engine | — |
| [`prompt-enhancement-context-none/`](prompt-enhancement-context-none/README.md) | Explicit draft-only adapter for tests and selected deployments | — |
| [`prompt-enhancement-llm/`](prompt-enhancement-llm/README.md) | No-tools auxiliary LLM provider with structured output | — |
| [`time-context/`](time-context/README.md) | Current-time and elapsed-time context | — |
| [`tmux-context/`](tmux-context/README.md) | tmux location context | — |
| [`agent-instructions/`](agent-instructions/README.md) | Workspace-instruction context | — |

Session references are documented in [docs/subsystems/session-reference.md](../../docs/subsystems/session-reference.md), Prompt Enhancement in [docs/subsystems/prompt-enhancement.md](../../docs/subsystems/prompt-enhancement.md); the [`agent-instructions` decision record](../../.agents/notes/implemented/feature/2026-06-24-workspace-context.md) owns its per-agent/session isolation and lifecycle split.
