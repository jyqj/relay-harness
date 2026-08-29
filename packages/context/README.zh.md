# context/ — 请求上下文扩展

[English](README.md) | 中文

在不定义工具的情况下添加模型可见请求上下文的产品插件。`agent-instructions` 包含在默认 `rlh-agent-spine-demo` 组合包中，可通过组合包配置禁用。Base bundle 组合 `context-engine` 与 purpose-specific Session History provider；Web 再加入 Prompt Enhancement 的 Context Engine／LLM 适配器和文件引用发现。其余包需主动启用。

| 包 | 职责 | ctx key |
|---|---|---|
| [`context-engine/`](context-engine/README.md) | 步骤上下文 contributor 注册表与证据协议 seam | `ctx.contextEngine` |
| [`session-history-context/`](session-history-context/README.md) | Prompt Enhancement 的有界持久当前 Session 历史 | `ctx.sessionHistoryContext` |
| [`session-reference/`](session-reference/README.md) | 其他会话的有界快照 | `ctx.sessionReferenceResolver` |
| [`file-reference/`](file-reference/README.md) | 文件引用发现 seam 与 `@file` 语法 | `ctx.fileReferences` |
| [`file-reference-local/`](file-reference-local/README.md) | 本地文件系统文件引用提供方 | — |
| [`code-context/`](code-context/README.md) | 基于 `ctx.codeIndex` 的代码索引召回 contributor | `ctx.codeContext` |
| [`prompt-enhancement/`](prompt-enhancement/README.md) | Prompt Enhancement 服务、提供方生命周期与 Remote | `ctx.promptEnhancement` |
| [`prompt-enhancement-context-engine/`](prompt-enhancement-context-engine/README.md) | 共享 Context Engine 的适配器 | — |
| [`prompt-enhancement-context-none/`](prompt-enhancement-context-none/README.md) | 供测试和指定部署使用的显式纯草稿适配器 | — |
| [`prompt-enhancement-llm/`](prompt-enhancement-llm/README.md) | 无工具、结构化输出的辅助 LLM 提供方 | — |
| [`time-context/`](time-context/README.md) | 当前时间与耗时上下文 | — |
| [`tmux-context/`](tmux-context/README.md) | tmux 位置上下文 | — |
| [`agent-instructions/`](agent-instructions/README.md) | 工作区指令上下文 | — |

会话引用见 [docs/subsystems/session-reference.md](../../docs/subsystems/session-reference.md)，Prompt Enhancement 见 [docs/subsystems/prompt-enhancement.md](../../docs/subsystems/prompt-enhancement.md)；[`agent-instructions` 决策记录](../../.agents/notes/implemented/feature/2026-06-24-workspace-context.md)规定了其按 agent（智能体）/会话隔离与生命周期拆分。
