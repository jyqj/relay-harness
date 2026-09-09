# @relay-harness/rlh-context-engine

[English](README.md) | 中文

本地上下文引擎 seam（`ctx.contextEngine`）的 Service Definition 与确定性控制平面实现：purpose 资格、Provider 本地检索 deadline 与配额、整消息打包、决策 trace，以及 contributor 与知识 Provider 适配器之间交换的证据、覆盖与可观测性词汇。设计权威：Relay 根仓库 `docs/adr/0006-local-context-engine.md`（ADR-0006）与 `docs/agent/context-engine.md`。

AgentLoop 在 inbox 领取与提示词组装之间调用该 seam（见 [architecture 轮次流](../../../docs/architecture.md#turn-flow)）；选中消息追加进步骤的 user 消息并落为持久 `user/message` 事件。步骤获准后，AgentLoop 还会在这些消息之后、模型请求之前记录一条仅存在于日志的 `context/prepared` trace；它保留已解析 plan、选中／拒绝决策、contributor 归属、JSON 安全的证据、覆盖记录与精确消息事件 seq 链接，但不复制 transcript 内容。所有合格 contributor 都主动放弃时返回 `undefined`；timeout、已释放代际、重复或预算拒绝会返回仅含拒绝信息的准备结果，让获准步骤记录未注入上下文的原因。

## Service API（`ctx.contextEngine`）

| 成员 | 语义 |
|---|---|
| `registerContributor(contributor)` | 原子保留唯一非空 contributor id；无效或重复注册不发布任何内容并抛出 `ContextEngineError`（`CONTEXT_ENGINE_INVALID_CONTRIBUTOR` / `CONTEXT_ENGINE_CONFLICT`）。返回只移除该注册的 disposer。 |
| `prepareStep(input)` | 解析 purpose 资格与局部配额，以子 abort signal 和 deadline 运行每个合格 contributor，再让显式引用先于 Provider 发现结果参与预算选择与去重。选中消息仍保持注册顺序。不可变结果带 plan、decisions、带归属 contribution、消息、证据与覆盖。畸形 payload、空／候选内重复 Evidence id，或选中候选之间的重复 Evidence id 会原子失败。只有全部合格 contributor 都主动放弃且没有拒绝需要记录时才返回 `undefined`。 |

planner 是确定性的，不调用模型。`StepContextContributor.purposes` 声明 Provider 资格；省略时支持全部 purpose。每个合格 Provider 都收到带局部字符／token 上限、timeout 与绝对 deadline 的 `StepContextInput.budget`。Provider 保留自己的检索算法，并应在该配额内裁剪。子 signal timeout 不会中止父请求，因此后续 Provider 仍会运行；超时或已释放注册代际的迟到结果会被忽略。父请求 signal 仍会原子中止整次准备。

## 配置

| 字段 | 默认值 | 含义 |
|---|---:|---|
| `maxChars` | `64000` | 所有选中上下文消息的 Unicode code point 总上限。 |
| `maxTokens` | `16000` | `ctx.tokenMeter` 下的总 token 上限；meter 缺席时使用引擎的确定性后备估算。 |
| `maxContributorChars` | `64000` | 单 Provider 字符上限。 |
| `maxContributorTokens` | `16000` | 单 Provider token 上限。 |
| `prepareTimeoutMs` | `5000` | 包含排队时间的完整准备期限；未完成 Provider 记录 `deadline`。 |
| `maxConcurrentContributors` | `4` | 每次准备的 Provider 并发读取上限。 |
| `contributorTimeoutMs` | `5000` | 单 Provider wall-clock deadline；超时只中止该 Provider 读取。 |

## 词汇

`ContextRetrievalPlan` 在 Provider 运行前记录 purpose 资格及解析后的总／局部预算。`ContextCandidateDecision` 以稳定 reason 记录 `selected` 或 `rejected`，例如 `timeout`、`disposed`、`duplicate` 及拒绝候选的字符／token 预算。`ContextCandidateSelection` 让显式文件、代码路径或 MCP Resource 引用优先于 Provider 发现的 recall，而不把检索移进引擎。`ResourceRef`、`Evidence`、`CoverageRecord`、`NegativeFinding` 及 Provider health/generation/explain 类型保持 Provider 中立语义。全部类型见 [`src/types.ts`](src/types.ts)，投影见 [docs/subsystems/context-engine.md](../../../docs/subsystems/context-engine.md)。

## Model Experience

无。该可信 seam 自身不注册任何面向模型的提示词、schema、工具或消息；contributor 拥有自己的消息 source，引擎只负责排序与记录。

#### KV Cache effect

间接且由 contributor 所有；贡献的消息追加在已领取 user 消息之后、位于可复用请求前缀之后，注入不会使既有 KV-cache 条目失效。

## Known Limitations and Deferred Work

- **协作式资源取消** —— deadline 丢弃迟到结果并发送取消信号，但不合作的 Provider 可能继续底层工作；timer 无法抢占同步 JavaScript。
- **整消息打包** —— Provider 在局部配额内自行裁剪／hydrate；引擎会拒绝超大 contribution，而不会切开 Provider 自有的消息／Evidence 对应关系。
- **Provider 覆盖仍不完整** —— 发行的 file-reference、本地 code-index、长期记忆、Prompt 专用 Session History 与 MCP Resource contributor 会生成 Evidence；通用 session-query 与 LSP Provider 仍待实现。
- **Hydration policy 仍由 Provider 所有** —— 引擎校验 JSON 持久性与 Evidence identity；各来源 Provider 拥有当前源读取、revision 对比及内容 digest 验证。
