# Agent Note: 持久上下文准备 trace

Status: implemented

[English](2026-08-29-durable-context-preparation-trace.md) | 中文

## Problem

上下文 contributor 会返回绑定 revision 的证据与检索覆盖，但 ContextEngine 会丢弃覆盖，AgentLoop 也只消费贡献消息。模型可见消息能够 replay，而 freshness、来源检查和检索反馈所需的证据会在请求前消失。仅持久化消息无法区分哪个 contributor 支持哪条消息，也无法判断 `agent/pre-step` 是否移除了拟议上下文消息。

## Decision

`prepareStep()` 返回每个带 contributor id、消息、证据与可选覆盖的 contribution，并提供直接的消息、证据和覆盖聚合。ContextEngine 会在边界处对每个 Provider 自有结果做脱离、无损 JSON 校验与深冻结；重复或空 evidence id 会让整个准备失败。`Evidence.domain` 只接受无损 `JsonValue`，因此可变或无法上 wire 的 Provider payload 不会一直存活到之后的 AgentLoop append 或 Prompt Enhancement Remote 序列化。

ContextEngine 仍不拥有 Session。AgentLoop 让准备结果穿过普通 `agent/pre-step` 决策，并且只为获准步骤按以下顺序追加事件：`step/start`、经准入的 `user/message` 事件、一条纯日志 `context/prepared` 事件，随后物化 request header 并分派模型。trace 记录 contributor 归属、证据、覆盖，以及经准入后仍未改写的精确消息记录 seq。拟议消息被移除或改写时会保留空 seq 列表，因此来源绝不会声称改写后的文本受到原始证据支持。消息内容只存在于 `user/message`；`context/prepared` 不是第二份 transcript，也不参与 `deriveMessages()`。

context-engine invariant 会拒绝不在命名开放步骤内的 trace、同一步骤的第二条 trace、晚于 request/model/tool 活动的 trace、重复的 contributor 或 evidence id，以及指向其他步骤、后续事件、非消息事件、重复事件或不同消息 id 的链接。持久化 reload、compaction 与闭合轮次 fork 都会保留链接，因为 seq 与消息 id 是不可变日志身份；trace 始终仅存在于日志，surface rewrite 只影响派生模型历史。

## Alternatives considered

- **让 ContextEngine 自行追加事件** —— 拒绝，因为只有 AgentLoop 知道 `agent/pre-step` 是否准入步骤，以及哪些精确消息进入了模型可见 surface。
- **把证据存进每条 `user/message`** —— 拒绝，因为消息 source 类型会继承 Provider 专用来源，surface replacement 需要保留检索元数据，而且每个 transcript consumer 都会承担其不渲染的数据。
- **只持久化消息 id，不持久化事件 seq** —— 拒绝，因为 id 能跨表示识别内容，却不能识别某个步骤准入的精确持久出现位置。
- **只记录经准入的 contribution** —— 拒绝，因为移除与改写是诊断和反馈所需的检索结果；显式空链接列表能保留该事实，又不会把拟议消息称为模型可见。

## Consequences

每个获准上下文准备结果都会增加一条纯日志事件，并在持久存储中复制一次证据与覆盖，但不会增加模型 token。Client Remote 组合会重新导出事件 payload、Evidence 与 coverage 类型，因此 SDK consumer 可以直接收窄历史 API 交付的通用 `SessionEvent<'context/prepared'>`。客户端可以从会话事实构建来源 drawer 与反馈投影，无需查询易失的 Provider 状态。非 JSON 或重复 evidence 的 Provider 结果会在 AgentLoop 打开步骤或准入任何模型可见上下文前，于 `prepareStep()` 内原子失败，而不会留下部分 transcript 或产生无法 replay 的请求。
