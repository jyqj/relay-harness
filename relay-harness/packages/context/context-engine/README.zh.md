# @relay-harness/rlh-context-engine

[English](README.md) | 中文

本地上下文引擎 seam（`ctx.contextEngine`）的 Service Definition：上下文 contributor 注册表、每个请求一次确定且带 purpose 的 `prepareStep` 通行，以及 contributor 与知识 Provider 适配器之间交换的证据、覆盖与可观测性词汇。设计权威：Relay 根仓库 `docs/adr/0006-local-context-engine.md`（ADR-0006）与 `docs/agent/context-engine.md`。

AgentLoop 在 inbox 领取与提示词组装之间调用该 seam（见 [architecture 轮次流](../../../docs/architecture.md#turn-flow)）；贡献的消息追加进步骤的 user 消息并落为持久 `user/message` 事件。步骤获准后，AgentLoop 还会在这些消息之后、模型请求之前记录一条仅存在于日志的 `context/prepared` trace；它保留 contributor 归属、JSON 安全的证据、覆盖记录与精确消息事件 seq 链接，但不复制 transcript 内容。无贡献的步骤与未部署该服务的部署逐字节一致。

## Service API（`ctx.contextEngine`）

| 成员 | 语义 |
|---|---|
| `registerContributor(contributor)` | 原子保留唯一非空 contributor id；无效或重复注册不发布任何内容并抛出 `ContextEngineError`（`CONTEXT_ENGINE_INVALID_CONTRIBUTOR` / `CONTEXT_ENGINE_CONFLICT`）。返回只移除该注册的 disposer。 |
| `prepareStep(input)` | 按注册顺序、每 contributor 一次地运行全部已注册 contributor，输入为显式 purpose、消息、中止信号、工作目录及分离的持久 caller identity（session、Agent、workspace、turn／step、preset、origin）；对每个返回 contribution 做脱离、无损 JSON 校验与冻结后，再返回带归属的 contribution 以及消息、证据与覆盖聚合。畸形 payload 或重复/空 evidence id 会以 `CONTEXT_ENGINE_INVALID_CONTRIBUTION` 原子失败。无任何贡献时返回 `undefined`。 |

contributor 按注册顺序串行执行，保证打包后的消息顺序跨重启确定可复现；并行扇出随检索 planner 到来。必填 `purpose` 让普通 agent-step 检索与无副作用 Prompt Enhancement 准备复用同一 seam，而无需从消息文本推断意图。工作集与显式引用随消息本身到达（文件提及、会话引用），使请求构造无需模型调用即保持确定性。

## 词汇

`ResourceRef` 以 `sourceId` + 不透明 `key` + 可选 `revision`（省略表示显式未知，绝不是"任意版本"）寻址一个资源。`Evidence` 是绑定该 revision 的一条已准入观察，带 `digest`、`truncated`、`freshness`、`verification`——`unverified` 是显式状态而非默认值；Provider 自有的 `domain` 数据必须是无损 JSON，因为获准证据会进入持久 trace。evidence id 在完整准备结果中必须唯一。`CoverageRecord` 记录一次检索实际检查了什么（`searched`、`notSearched`、`rationale`、`completeness`）；`NegativeFinding` 携带断言、检查过的范围与置信级别；无覆盖记录的零命中读作"此处未找到"，绝不是"不存在"。`ProviderHealthState`、`ProviderGeneration`（index/evidence 双时钟代际）与 `ProviderExplain`（稳定 token 截断原因、降级读错误）是 CodeCortex 桥接等知识 Provider 适配器将报告的可观测性面。全部类型见 [`src/types.ts`](src/types.ts)，投影见 [docs/subsystems/context-engine.md](../../../docs/subsystems/context-engine.md)。

## Model Experience

无。该可信 seam 自身不注册任何面向模型的提示词、schema、工具或消息；contributor 拥有自己的消息 source，引擎只负责排序与记录。

#### KV Cache effect

间接且由 contributor 所有；贡献的消息追加在已领取 user 消息之后、位于可复用请求前缀之后，注入不会使既有 KV-cache 条目失效。

## Known Limitations and Deferred Work

- **仅排序** —— `prepareStep` 只排序与拼接贡献；检索规划、预算划分、hydration 验证与打包策略在后续阶段落地并增强该 seam，而非替换它。
- **Provider 覆盖仍不完整** —— 发行的 file-reference、本地 code-index、长期记忆、Prompt 专用 Session History 与 MCP Resource contributor 已生成 Evidence；通用 session-query、LSP 与统一 planner policy 仍待实现。
- **无按 contributor 的超时策略** —— contributor 收到步骤信号并必须透传。引擎在每个 contributor 前后检查取消，abort 后绝不运行后续 contributor；但它无法中断忽略 signal 的 contributor，也尚未强制 deadline。
