# Agent Note: Input submit attempts freeze the occurrence table with the draft

Status: implemented

[English](2026-09-03-input-submit-attempt-occurrence-snapshot.md) | 中文

## Problem

发送管线拼接 reference 的 model form 时依赖两个不同时刻捕获的来源：draft 来自 attempt 的 enter 时刻 `draftSnapshot`，而 occurrence offset 来自 sink effect 执行时读取的 `core.state.occurrences`。机器在 `adjudicating`/`submitting` 期间仍然接受 `draft-changed`（InputBar 只在 UI 层挡交互编辑，`actions.setDraft` 按设计没有 phase 守卫），因此落在 adjudication 窗口内的写入——例如外部 mention 插入——会移动 live 表。随后的 `default-sink` effect 于是用 enter 时刻的 draft 文本对照已移位的 live offset 拼接，产出损坏的 model form（`/ask @@[Research](…)`）：display 文本的 `@` 残留在序列化 reference 旁边。

## Decision

`SubmitAttempt` 现在与 `draftSnapshot` 一起携带 occurrence 表，两者都在 enter 时刻由 `InputMachine.beginAttempt` 捕获。`SessionInputShell.sinkSerialized` 改读 `attempt.occurrences` 而非 live 表，使拼接基准自洽：draft 与 offset 描述同一时刻。busy 期的外部写稿因此只影响下一次发送，与既有的结算规则（flight 期间用户输入获胜）一致。

没有给机器或 `actions.setDraft` 增加 admission-phase 守卫。在 `adjudicating`/`submitting` 期间拒绝写入会破坏合法的 busy 期输入路径（Host 往返期间的 draft 保留、commit 时的纯后缀保留），并迫使迁移 InputZone currency 消费的 `InputState` 快照语义。

## Alternatives considered

**busy 期拒绝 `draft-changed`（phase 守卫）。** 已否决：`onSubmitSettled` 已把 busy 期编辑定义为在 commit 后保留、rollback 时获胜的更新输入；守卫会作废该行为，并要求重做所有 mid-flight 读取 `InputState` 快照的 consumer。

**在 sink effect 执行时刻捕获表。** 已否决：plain-submit 路径同步执行 `default-sink`，正确性只是巧合；adjudicating 路径的 effect 在异步窗口之后才解析，sink 时刻的任何捕获仍是第二次竞态读取而非修复。

## Testing

`input-machine.client.spec.ts` 证明两条 enter 路径（adjudicating 与 claimed→submitting）都在 attempt 上冻结 enter 时刻的表，且 busy 期编辑只移动 live 表。`input-reference-submit.client.spec.ts` 端到端复放该缺陷：带 chip 的 `/` 行进入 adjudication，窗口期内 `actions.setDraft` 前插文本，sink 必须收到 enter 时刻投影（`/ask @[Research](…)`），而不是错位的 `@@` 变体。`packages/client/ui-conversation/tests` 全量通过。

## Consequences

外部写入与 submit transaction 的任何交错下，serialize-then-splice 现在都正确。attempt 对象每次发送多持有一个数组引用（冻结表共享、从不复制）。InputBar 的 busy 守卫保持为表现层关注点，其注释与 `SubmitAttempt`、`InputActions.setDraft` 的 JSDoc 一并显式声明了该契约。
