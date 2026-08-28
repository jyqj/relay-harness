# @relay-harness/rlh-context-engine

[English](README.md) | 中文

本地上下文引擎 seam（`ctx.contextEngine`）的 Service Definition：步骤上下文 contributor 注册表、每个已领取 agent 步骤一次确定性 `prepareStep` 通行，以及 contributor 与知识 Provider 适配器之间交换的证据、覆盖与可观测性词汇。设计权威：Relay 根仓库 `docs/adr/0006-local-context-engine.md`（ADR-0006）与 `docs/agent/context-engine.md`。

AgentLoop 在 inbox 领取与提示词组装之间调用该 seam（见 [architecture 轮次流](../../../docs/architecture.md#turn-flow)）；贡献的消息追加进步骤的 user 消息并落为持久 `user/message` 事件，无贡献的步骤与未部署该服务的部署逐字节一致。

## Service API（`ctx.contextEngine`）

| 成员 | 语义 |
|---|---|
| `registerContributor(contributor)` | 原子保留唯一非空 contributor id；无效或重复注册不发布任何内容并抛出 `ContextEngineError`（`CONTEXT_ENGINE_INVALID_CONTRIBUTOR` / `CONTEXT_ENGINE_CONFLICT`）。返回只移除该注册的 disposer。 |
| `prepareStep(input)` | 按注册顺序、每 contributor 一次地运行全部已注册 contributor，输入为已领取消息、步骤中止信号与会话 header 的工作目录；拼接贡献的消息与证据。无任何贡献时返回 `undefined`。 |

contributor 按注册顺序串行执行，保证打包后的消息顺序跨重启确定可复现；并行扇出随检索 planner 到来。工作集与显式引用随消息本身到达（文件提及、会话引用），使请求构造无需模型调用即保持确定性。

## 词汇

`ResourceRef` 以 `sourceId` + 不透明 `key` + 可选 `revision`（省略表示显式未知，绝不是"任意版本"）寻址一个资源。`Evidence` 是绑定该 revision 的一条已准入观察，带 `digest`、`truncated`、`freshness`、`verification`——`unverified` 是显式状态而非默认值。`CoverageRecord` 记录一次检索实际检查了什么（`searched`、`notSearched`、`rationale`、`completeness`）；`NegativeFinding` 携带断言、检查过的范围与置信级别；无覆盖记录的零命中读作"此处未找到"，绝不是"不存在"。`ProviderHealthState`、`ProviderGeneration`（index/evidence 双时钟代际）与 `ProviderExplain`（稳定 token 截断原因、降级读错误）是 CodeCortex 桥接等知识 Provider 适配器将报告的可观测性面。全部类型见 [`src/types.ts`](src/types.ts)，投影见 [docs/subsystems/context-engine.md](../../../docs/subsystems/context-engine.md)。

## Model Experience

无。该可信 seam 自身不注册任何面向模型的提示词、schema、工具或消息；contributor 拥有自己的消息 source，引擎只负责排序与记录。

#### KV Cache effect

间接且由 contributor 所有；贡献的消息追加在已领取 user 消息之后、位于可复用请求前缀之后，注入不会使既有 KV-cache 条目失效。

## Known Limitations and Deferred Work

- **仅排序** —— `prepareStep` 只排序与拼接贡献；检索规划、预算划分、hydration 验证与打包策略在后续阶段落地并增强该 seam，而非替换它。
- **尚无 Provider 适配器** —— 将规模化产出 `Evidence` 的 session-query、memory、CodeCortex、LSP 适配器均推迟；`file-reference-local` 是第一个 contributor。
- **无按 contributor 的取消策略** —— contributor 收到步骤信号并必须透传；引擎尚不强制 per-contributor 超时。
