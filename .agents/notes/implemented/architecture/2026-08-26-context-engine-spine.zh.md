# Agent Note: Context engine spine — 步骤上下文 seam（claim 与 assembly 之间）

Status: implemented

[English](2026-08-26-context-engine-spine.md) | 中文

## Problem

模型可见的请求上下文此前是一组相互独立的 pre-step 插件（`session-reference`、`time-context`、`tmux-context`），各自拥有检索、渲染与注入逻辑，也没有共享词汇描述上下文的依据：哪个来源、哪个 revision、检索过什么。Relay 根仓库的上下文引擎设计（`docs/adr/0006-local-context-engine.md`（ADR-0006）与 `docs/agent/context-engine.md`）要求一个本地控制面，在检索结果到达模型请求之前把它变成绑定 revision 的证据——并要求 AgentLoop 在 inbox 领取与提示词组装之间查询它：此时已领取消息可见，而提示词尚未冻结。

## Decision

AgentLoop 在 `preStep()` 中拥有一个可选 seam：在 `this.inbox.claim(...)` 之后、工具快照捕获与 `systemPrompt.assemble` 之前，循环读取 `this.loopCtx.get('contextEngine')`，存在时 await `prepareStep({ purpose: 'agent_step', messages: claimed, signal, cwd })`。Prompt Enhancement 以 `prompt_enhancement` 使用同一个 purpose 必填入口，使 contributor 无需解析自然语言即可获得调用方意图。贡献的消息追加进步骤的 user 消息、置于 runtime-context 快照之前，流经普通的 `agent/pre-step` 瀑布，并落为持久 `user/message` 事件，因此 model-visible ⟺ logged 成立。获准的准备结果还会成为[持久上下文准备 trace 决策](2026-08-29-durable-context-preparation-trace.md)描述的纯日志 `context/prepared` 事实。无贡献的步骤、未部署该服务的部署，与不含该 seam 的部署逐字节一致。

循环通过与 `visionFallback` 相同的可选服务模式发现引擎；其结构化服务面使用 ContextEngine 包的纯类型依赖，使返回的归属、证据、覆盖与持久事件词汇不会漂移。

seam 本体是 `@relay-harness/rlh-context-engine`（`ctx.contextEngine`，Service Definition）：contributor 注册表（`registerContributor`，唯一 id、disposer、全有或全无校验）与 `prepareStep`——按注册顺序串行运行 contributor，使打包消息顺序跨重启确定。每个结果都在消息、证据和可选覆盖外保留 contributor 身份，同时继续向直接 consumer 提供聚合数组。其 `src/types.ts` 拥有从审计过的参考设计迁移来的协议词汇：`ResourceRef`/`Evidence`（绑定 revision 的观察，`unverified` 是显式状态）、`CoverageRecord`/`NegativeFinding`（零命中读作"此处未找到"，绝不是"不存在"）、以及供后续阶段知识 Provider 适配器使用的 `ProviderHealthState`/`ProviderGeneration`/`ProviderExplain`（双时钟代际、稳定 token 截断原因）。

## Alternatives considered

- **`system-prompt/assemble` 瀑布监听器** —— 能看到 `AssembleContext` 字段，但运行在 assembly 对象上而非已领取消息上，且不重新推导就无法把贡献消息排为已领取 user 消息；它还发生在工具快照之后。
- **每个来源一个 `agent/pre-step` 插件**（现状） —— 保留各插件的检索孤岛，没有共享证据协议；pre-step 瀑布也在组装之后运行，上下文无法影响提示词 section。
- **在 claim 与组装之间新增瀑布事件** —— 需要更大的 `SessionEventMap`/SDK 面变更，相比可选服务读取没有额外能力。

## Consequences

- `file-reference-local` 成为第一个 contributor：显式 `@path` 提及经 `ctx.fs` 按会话 header 的 cwd 解析，携带 stat 身份 revision 与内容摘要作为 `Evidence` 记录。
- 串行 contributor 执行限定了今日的每步成本；后续阶段的检索 planner、预算划分与打包策略在 seam 内部增强 `prepareStep`，而非替换它。
- 该循环变更更新了 [architecture 轮次流](../../../../docs/architecture.md)；`docs/subsystems/context-engine.md` 投影协议词汇，`scripts/gen-cordis-catalog.ts` 把 `ctx.contextEngine` 及其类型映射到该页。
