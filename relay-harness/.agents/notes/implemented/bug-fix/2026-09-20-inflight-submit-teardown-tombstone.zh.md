# Agent Note: 作用域销毁时在途提交推迟废弃草稿 tombstone 的判定

Status: implemented

[English](2026-09-20-inflight-submit-teardown-tombstone.md) | 中文

## 问题

`InputHub` 的会话作用域销毁逻辑会在投影草稿文本非空时记录废弃草稿 tombstone——即使此时一次提交正在发往 Host 的半途。shell 的 dead-attempt 守卫随后吞掉了 settle 结果，tombstone 由此宣称存在"未发送的输入"，而 Host 可能已经接受。用户重新打开时会看到一条"废弃草稿"提示，对应的消息其实已经送达，文本还会回到已送达消息旁边的输入框里。

## 决策

- `SessionInputShell` 统计正在等待 Host 往返的 default-sink 发送（机器提交路径与纯图片直发），并暴露两个 wiring-layer 面：`submitInFlight` 读取，以及 `afterDisposeSubmitSettle(cb)`——注册唯一一个回调，即使已 dispose 也会在 settle 时以"发送是否被接受"调用一次。
- Hub 的销毁路径在 dispose 之前检查在途状态。有发送在途时注册 settle 回调而不是立即 discard；没有时照旧立即记录 tombstone。回调只有在 settle 未报告接受时才记录 tombstone——错误 outcome 或 rejection；rejection 沿用既有图片发送语义，读作"可能未送达"。settle 时作用域已不存在且 Host 已接受，则不记录 tombstone。
- tombstone 文本取销毁时刻冻结的剪贴板投影；`DiscardedDraftRegistry` 的持久化结构不变。

## Alternatives considered（已考虑的替代方案）

**无条件抑制在途提交的 tombstone。** 拒绝：发送失败时会静默丢掉用户文本——这正是 tombstone 要防止的损失。

**新增显式的"不确定" tombstone 变体。** 拒绝：到 settle 时刻结果必然已知（接受、错误或 rejection），第三个状态不携带任何信息；新变体还要触及持久化 entries 结构和所有读取方，却没有行为收益。

**像成功路径一样在提交时乐观清空草稿。** 拒绝：草稿必须在发送失败后保留以便修改。只有 settle 结果能区分"已被接受"与"失败、保留"。

## 后果

- 往返途中会话作用域被销毁时，已接受的发送不再留下虚假 tombstone；发送失败仍通过 tombstone 保留文本。
- 永不 settle 的传输（Host 往返挂死）不会记录 tombstone，因为答案永远不到；dispose 时 attempt 信号被中止，default-sink 被要求在中止时 settle，因此该窗口受传输自身失败行为的约束。
- 在途计数只覆盖 default-sink 发送；命令面 claim（`claim.submit`）保留既有事务语义，本来也不是 tombstone 的输入。
- 回归覆盖：ui-conversation 的 draft-lifecycle spec 在提交中途销毁作用域，并断言推迟后的结果——接受时无 tombstone，失败时冻结文本进入 tombstone。
