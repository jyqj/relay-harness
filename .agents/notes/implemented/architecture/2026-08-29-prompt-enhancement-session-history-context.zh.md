# Agent Note：通过 Context Engine 为 Prompt Enhancement 提供 Session 历史

Status: implemented

[English](2026-08-29-prompt-enhancement-session-history-context.md) | 中文

## 问题

第一版原生 Prompt Enhancement 纵切面为显式文件和其他 provider-owned Evidence 复用了 Context Engine contributor，但没有提供持久对话历史。如果在 Prompt Enhancement 适配器或 LLM provider 中直接拉取 `session.deriveMessages()`，就会形成第二套上下文 composer，并递归重新引入先前的 recall／注入消息；它还会把失败 turn 和未完整提交的 compaction checkpoint 当作可信历史。

## 决策

`@relay-harness/rlh-session-history-context` 是 Host 拥有的 purpose-specific Context Engine contributor：

- 它拒绝 `agent_step`，因为 AgentLoop 已拥有普通 transcript；
- 它只通过分离后的 `StepContextInput.caller.sessionId` 与规范 `ctx.sessions` store 解析 caller；
- 它 fold 当前持久 Session surface，而不是 UI cache 或搜索索引；
- 直接用户／模型 exchange 只有在持久 turn 以 `completed` 关闭时才会接纳；
- compact checkpoint 只有在精确 start、summary、replacement 与成功 end 生命周期有序且完整时才会接纳；
- 它排除 recall／注入消息、工具、失败／中断／未完成 turn、shadowed 事件与失败 checkpoint，防止上下文递归；
- 它在 exchange、字符与共享 token-meter 预算下以 newest-first 选择，再按逻辑时间顺序发出已选单元；
- 它为每个被接纳来源事件附加一条带内容 digest、绑定事件 revision 的 Evidence，并提供解释策略与预算遗漏的 bounded Coverage。

Base bundle 只组合一次 contributor。Web Prompt Enhancement 通过既有 `prompt-enhancement-context-engine` 适配器到达它。任何 Prompt 包都不会导入或组装 Session 历史。

## Replay 与生命周期语义

Evidence identity 是 caller Session 下不可变的事件 sequence，revision 携带 SHA-256 内容摘要。Provider 的 semantic log revision 只忽略 constructor-only resume marker `session/end-seed`；因此在没有新语义事件时，重放持久事件会产生逐字节相同的历史文本、Evidence revision 与 Coverage。

Compaction checkpoint 即使 replacement event 拥有更晚的 append sequence，也会保留逻辑 surface 位置。因此 packing 遵循 `Session.surface.nodes`，绝不会按原始事件 sequence 重排已选历史。

## 结果

Prompt Enhancement 现在默认获得普通对话连续性与已批准摘要，而空对话不增加 Token。同一 Context Trace 会标识每个被选择的 Session 事件，以及每项策略／预算遗漏。后续 Retrieval Planner 可以替换 recency ranking，但必须保留这里实现的持久成功、compaction 审批、递归排除与 replay invariant。

## 备选方案

- **在 Prompt LLM provider 中读取 `session.deriveMessages()`**——否决，因为它绕过 Context Engine 的 Evidence、Coverage、预算与 purpose policy。
- **通过 session-query 索引／搜索当前 Session**——初始本地纵切面否决，因为规范 live Session 已拥有有序 current surface，而默认 session-query 数据库有意保持未打开。Session-query 仍适合跨 Session 语义检索。
- **包含所有 user-role surface 消息**——否决，因为 recall 与注入 policy 会递归成为新 Evidence。
- **包含所有 compaction replacement**——否决，因为没有成功 close 的 replacement 不是已批准 checkpoint。
