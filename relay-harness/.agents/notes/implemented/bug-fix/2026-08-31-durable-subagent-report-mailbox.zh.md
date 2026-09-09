# Agent Note: Durable subagent report mailbox

Status: implemented

[English](2026-08-31-durable-subagent-report-mailbox.md) | 中文

## Problem

`reportFrom()` 会返回 parent inbox 身份，却不保留持久的 child-side 投递事实。child 上报后、parent 记录消息前发生崩溃会丢失 report；重试也可能重复，因为两侧都没有幂等记录的所有权。

## Decision

执行上报的 child Session 拥有 outbound mailbox。发布到 parent inbox 前，`reportFrom()` 会追加并 flush `subagent/report-accepted { version, idempotencyKey, delivery, message }`。存储的消息已经包含稳定 `MessageId`、来源归因、框定文本和 quiet／next-step 策略。相同 key 的相同重试返回原回执；冲突复用失败。

parent 追加匹配的 `user/message` 时，在线管理器会向 child 追加 `subagent/report-delivered`。child 冷物化时也会把 parent 持久日志或当前 inbox 当作权威确认，因此 parent 已准入消息之后、child 确认之前崩溃不会重复 report。其余已接受 report 会按提交顺序回放，然后恢复的 child 才接收新工作。

重试身份比较规范化后的消息结构，而非 JSON 属性插入顺序。调整对象字段顺序会保留原回执；修改内容、来源归属或报告投递方式仍然构成冲突。数组顺序仍有意义。

每次同键重试都会再次跨过持久化屏障：内存中的 accepted 事件可能来自此前 flush 失败的调用。恢复保留原消息身份，仅在权威日志与 inbox 尚未包含消息时补投。活动投递会在异步屏障后重新核对 child 租约；报告在修改父级 inbox 前还会重新解析活动父级。

## Alternatives considered

**发送前把 report 存入 parent。** 未采用，因为 report 从 child authority 发起，而 child Session 是接受时唯一保证在线的持久对象；不存在跨 Session 原子追加。

**只把 parent inbox 当作回执。** 未采用，因为 inbox 状态仅限进程内，重启后会消失。

**增加后台 report pump。** 本切片未采用：只为 outbound 投递唤醒冷 child 需要独立调度和跨进程所有权。恢复发生在 child 下次物化时。

## Testing

测试会在 parent 尚未领取时持久化 quiet report，使用相同幂等 key 重试，拆除进程内 Activation，再从 JSONL 冷恢复，并断言新 parent inbox 中恰好出现一条保留原 id 的 report。既有 next-step 上报和完整 continuation 测试继续通过。

## Consequences

已接受 report 可在单 owner 进程重启和重试下避免丢失或重复。每条 report 会支付一次投递前 child-session flush，并在之后增加一条确认事件。初次接受时直接 parent 必须在线，恢复则等待 child 后续物化。Activation lease 仍仅限进程内；该 mailbox 不允许两个 Harness 进程并发投递。
