# Agent Note: Durable continuable-subagent delivery

Status: implemented

[English](2026-08-31-durable-continuable-subagent-delivery.md) | 中文

## Problem

可继续 child 会持久化自己的 Session 与描述符，但初始提示词和 follow-up 只有在 AgentLoop 将其领取进 `user/message` 后才具备持久性。因此，在 inbox 接受时返回 `MessageId` 夸大了恢复保证：该间隙中的进程故障会丢失已接受工作，调用方重试也没有稳定的幂等 key 或回执查询依据。

## Decision

child Session 充当持久投递 mailbox。初始提示词或 follow-up 进入 Agent inbox 前，继续执行管理器会追加 `subagent/delivery-accepted { version, idempotencyKey, message }`，并等待 Session 持久性屏障。返回的 `MessageId` 标识这条已存储消息，也是接受回执。`SubagentFollowupOptions.idempotencyKey` 让调用方可以在响应结果不确定时跨进程重试；内容和来源相同时返回原回执，冲突复用则失败。

已接受消息进入模型可见的 `user/message` 日志后，管理器会追加 `subagent/delivery-claimed`。mailbox 投影也会把 `user/message` 本身视为已领取，因此在模型可见提交之后、确认事件之前崩溃不会重复投递。冷物化只折叠 child 自身的后缀，按提交顺序回放已接受但未领取的消息，然后才接受调用方的新 follow-up。若某条投递完成持久提交时，其 Activation 已开始 dispose，该消息会保留待处理，交给下一次冷物化，而不会进入正在关闭的 handle。

Agent inbox 仍是唯一执行 FIFO。持久 mailbox 事件描述恢复所有权，不是第二个 scheduler：回放会通过 `Agent.followup()` 提交每条待处理的带身份消息，之后照常由 AgentLoop 负责轮次排序。

重试身份比较规范化后的消息结构，而非 JSON 属性插入顺序。调整对象字段顺序会保留原回执；修改内容、来源归属或报告投递方式仍然构成冲突。数组顺序仍有意义。

每次同键重试都会再次跨过持久化屏障：内存中的 accepted 事件可能来自此前 flush 失败的调用。恢复保留原消息身份，仅在权威日志与 inbox 尚未包含消息时补投。活动投递会在异步屏障后重新核对 child 租约；报告在修改父级 inbox 前还会重新解析活动父级。

## Alternatives considered

**在独立队列数据库中只持久化调用方原始内容。** 未采用，因为 child Session 已经拥有持久排序、来源归因、版本拒绝、修复与 flush 语义；另一个存储会要求跨两个权威来源的事务。

**在 inbox 领取时确认。** 未采用，因为领取早于 `user/message`；在确认之后、模型可见追加之前崩溃仍会丢失投递。表层事件才是提交点，显式确认只作为紧凑投影辅助。

**返回新的回执对象。** 未采用，因为现有 `MessageId` 已经跨 inbox、日志和重试标识确切的持久 `UserMessage`。新增 route／status 包装只会重复生命周期状态，不会提高保证。

**同一次变更加入跨进程 Activation lease。** 未采用，因为它需要覆盖 backend 的 lease schema、续约、fencing 与接管语义。mailbox 已为受支持的单进程 owner 关闭消息丢失；在完整 lease 协议落地前，并发进程仍不受支持。

## Testing

继续执行测试会在一条已接受消息仍未领取时终止进程内 Activation，基于同一 JSONL 持久化启动全新 runtime，并证明旧投递先于新 follow-up 进入历史。测试也证明相同 key 重试会返回同一回执、只持久化一条 accepted 事件，且内容只执行一次。完整 subagent 包测试会在持久性屏障加入后继续覆盖既有取消、drain、dispose、冷恢复与排序竞态。

## Consequences

已接受的初始提示词或 follow-up 无需等待轮次开始，也能在进程重启后恢复。调用方保留幂等 key 时，可以安全重试结果不确定的 follow-up 响应。返回回执要求 accepted 事件立即持久化。进入模型可见表层后才追加 claimed 事件。Activation 驻留仍在进程内；启用 [fenced lease 协议](2026-09-05-persistence-commit-takeover-exclusion.md)的部署会串行化跨进程所有权与 child 持久化变更。
