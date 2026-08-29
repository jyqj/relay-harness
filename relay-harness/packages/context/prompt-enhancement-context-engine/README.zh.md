# @relay-harness/rlh-prompt-enhancement-context-engine

[English](README.md) | 中文

把 Prompt Enhancement 映射到目标 Agent 既有 `ctx.contextEngine` 的 Context 提供方。它使用 `purpose: 'prompt_enhancement'`、作为 claimed user message 的精确草稿、分离后的调用方身份（`sessionId`、`agentId`、工作区、preset 与 origin）和调用方取消信号调用一次 `prepareStep()`。返回消息保持 Context Engine 顺序；既有 contribution、Evidence 和 coverage 类型被投影为不透明 JSON trace，而不会在此重新定义。适配器会在返回前让完整 trace 通过 Session 的无损 JSON snapshot 边界，因此即使有人以结构类型替换 Context Engine，也无法把 `Map`、`Date`、cycle 或其他不能上 wire 的值泄漏进 Remote 结果。

Agent scope 缺少 Context Engine 时，适配器会明确失败。空的准备结果是合法结果，且与引擎缺失不同。

## 模型体验

### 共享的已准备上下文

#### 模型看到什么

在 `purpose: 'prompt_enhancement'` 下，Prompt Enhancement 模型只看到共享 Context Engine contributor 所选消息，随后是增强提供方的草稿消息。Base 组合中的 purpose-specific Session History contributor 会加入已完成的直接用户／模型 exchange 与已批准 compaction checkpoint，同时拒绝普通 Agent step。

#### Token 影响

Contributor 消息给独立辅助请求增加由数据决定的 Token；适配器不添加额外说明文本。

#### KV Cache 影响

上下文变化可能改变辅助请求，但绝不改变主 Agent 请求的前缀。

## 已知限制与延后工作

- Context Engine 仍然只负责顺序执行；Planner 预算、超时和 purpose-aware contributor 策略依赖该共享服务继续演进。
- Session History 当前使用确定性 recency packing，而非语义排序；跨 Session 语义历史仍是独立 provider 的职责。适配器有意不自行组合历史。
