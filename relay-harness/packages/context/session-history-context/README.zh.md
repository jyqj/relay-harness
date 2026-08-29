# @relay-harness/rlh-session-history-context

[English](README.md) | 中文

Host 拥有的持久对话历史 Context Engine contributor。它只在 `purpose: 'prompt_enhancement'` 时运行；普通 `agent_step` 请求不会得到 contribution，因此 AgentLoop 不会收到既有 transcript 的重复副本。

Contributor 通过 `ctx.sessions` 解析 `StepContextInput.caller.sessionId`，检查完整不可变事件日志与当前 Session surface，并发出一条以 JSON framing 的不可信 recall 消息。它只接纳当前 surface 上、持久 `turn/end` 为 `completed` 的直接用户／模型 exchange，以及拥有完整 `compaction/start` → `compaction/summary` → replacement → 成功 `compaction/end` 生命周期的压缩 checkpoint replacement。Recall／注入上下文、工具、失败／中断／未完成 turn、被 shadow 的事件和未批准 checkpoint 都不会重新进入结果。

选择在保持逻辑 surface 时间顺序的同时，根据 `maxExchanges`、`maxChars` 与共享 `ctx.tokenMeter` 估算器的 `maxTokens` 优先保留最新单元。最新单元过大时会在不破坏 JSON envelope 的前提下裁剪。每个被接纳的来源事件都会生成绑定 revision、带 SHA-256 digest 的 Evidence，记录 current freshness、verified 状态、role／turn／checkpoint 来源和明确选择原因；Coverage 记录完整日志／surface 范围、策略排除、预算遗漏与裁剪。

Base bundle 只组合一次该 provider。Web Prompt Enhancement 适配器通过 `@file`、代码与 Memory provider 共用的同一次 `ctx.contextEngine.prepareStep()` pass 到达它；本包不会调用 Prompt Enhancement 服务，也不拥有第二套 composer。

## 模型体验

### 持久 Session 历史 recall

#### 模型看到什么

一条 plugin／user-role 消息（`source.plugin = 'session-history-context'`、`form = 'recall'`），其中包含按时间顺序排列的成功 exchange 与已批准 checkpoint 的不可信 JSON 数组。当前未提交草稿仍是独立的 Prompt Enhancement 消息。

#### Token 影响

消息同时受 exchange 数、Unicode code point 与共享确定性 Token 估算器限制。空历史和所有普通 Agent step 都不会产生该消息。

#### KV Cache 影响

已完成的 Session 历史会改变独立 Prompt Enhancement 请求，但不会改变普通 Agent 请求前缀。

## 已知限制与延后工作

- 当前选择是确定性的 recency packing，而非语义历史检索。后续共享 Planner 可以在保留该 provider 持久准入规则的前提下排序 exchange。
- Contributor 只纳入文本 block。图片、reasoning、工具调用和工具结果应由独立 purpose-specific Evidence provider 处理，而不是在这里做有损内联转换。
