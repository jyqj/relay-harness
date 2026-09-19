# Agent Note: Explicit composer draft lifecycle

Status: implemented

English | [中文](2026-09-20-composer-draft-lifecycle.zh.md)

## Problem

Composer 输入是用户数据，但其存续规则此前是隐式的。逐会话输入状态机持有活跃草稿并将其镜像到会话 chat store，因此路由切换与刷新本就能保留草稿——然而在仍有未发送输入时销毁 Session scope 会静默丢掉这些输入：slots 框架的 `pruneStoreScope` 清除了持久化的 chat 状态，而没有任何界面呈现丢失了什么。连接断开期间草稿处于什么状态也没有答案，且不存在显式的丢弃动词。RFC §5.4 要求相反的姿态：导航既不提交也不丢失草稿，被销毁目标的草稿以"已失效"呈现（绝不静默显示为活跃输入），连接 epoch 变化从不擦除输入。

## Decision

会话包在既有持久化之上拥有一个三段式生命周期，而不是引入第二个草稿 store。

活跃草稿保持其原有持久化：以 Session 身份为键的逐会话 chat store 镜像（`rlh.conversation.chat.<sessionId>`）。conversation、Work 与 Library 之间的导航既不提交也不触碰它——隐藏的主页面保持 composer 挂载。

失效草稿位于根作用域的 `DiscardedDraftRegistry`（`input/drafts.ts`），持久化于 `rlh.conversation.drafts.discarded`，并有界地保留最新条目。scope 销毁时，InputHub 在 dispose shell 之前捕获草稿的 clipboard 投影；非空投影成为以 Session id 为键的 tombstone。销毁前已被携带或清空的草稿（Workspace 切换）不产生记录，成功提交也不产生——状态机早已清空草稿。会话再次存活时，`ConversationRoot` 从 inject hooks 读取逐会话 face，在 composer 上方渲染失效提示，并提供显式恢复（取出 tombstone，文本经 `inputActions.setDraft` 写回）与丢弃（删除 tombstone）操作。tombstone 绝不会作为活跃文本被播种进 composer，且 registry 跨刷新持久化，页面关闭期间被失效的草稿在重开后仍会呈现。

连接 epoch 变化把草稿视为惰性而非消失：`apply` 将 connection readiness face 展平为 composer-bar inject hooks 中的 `connected` observable，为 false 时 InputBar 保持提交惰性（发送按钮禁用、Enter 空操作），textarea 仍可编辑，草稿原样保留直至目标恢复可写。缺少 readiness face 的组合（对象层启动）保持 ready——缺席从不禁用 composer。

## Alternatives considered

- 给逐会话 chat store 增加生命周期字段：实例及其持久化状态恰好在需要失效标记存活的时刻被 `pruneStoreScope` 销毁，因此 tombstone 需要一个比 session scope 更长寿的拥有者。
- 像过去一样删除失效草稿并依赖对话记录：静默销毁用户输入正是该生命周期要阻止的失败。
- 在 `connection/reset` 时擦除草稿：用户文本不是 generation 作用域的状态；擦除它是对传输事件的惩罚，而"在 sink 失败"相比"保持不动"只是多了错误横幅的同等损失。
- 复用 ui-product-shell 的 `workAvailability` 助手：product shell 对本包是 peer 依赖，该导入会反转依赖方向；composer 只需要把 readiness 展平为一个布尔值。

## Consequences

未发送输入如今在所有先前会丢失它的生命周期路径上都能存活，代价是一条持久化的根作用域记录（有界），且按设计可以比其会话更长寿。失效提示是 conversation 包的呈现层；其他寻址已销毁会话的界面（被动 record 页）有意不显示 composer，因此也不显示 tombstone。断连期间的提交在交互层静默保持，而非在 sink 失败，因此 send-failed toast 路径现在只覆盖真正的准入失败。

## Testing

`packages/client/ui-conversation/tests/draft-lifecycle.client.spec.tsx` 覆盖 registry 契约（拒绝空输入、恢复、丢弃、有界化、刷新持久化）、真实 hub 与 sessions runtime 之下 scope 销毁时的 tombstone 创建、无 tombstone 路径（提交成功、携带清空），以及 `tests/skeleton.client.spec.tsx` 中带恢复/丢弃接线的根级呈现。离线草稿"惰性但完好"由 `tests/input-bar.client.spec.tsx` 固定，包括恢复 ready 后同一草稿的再次提交。路由标识不携带草稿由 `packages/client/ui-product-shell/tests/navigation.client.spec.ts` 按构造保证。
