# Agent Note:session.prompt 逐字准入、提交点前取消与 rpcId 幂等

Status: implemented

[English](2026-09-03-session-prompt-verbatim-admission-and-precommit-cancel.md) | 中文

## 问题

`session.prompt` 的 Service Definition 承诺了一个从未存在过的宿主侧 slash 命令分发。三处表面在描述它——`command?` 响应槽、`command-error`/`unknown-command` 两个错误码、以及"以 '/' 开头的 prompt 绝不送达模型"的声明——而网关实际上把每条 prompt 逐字准入,真实的命令通道在别处(客户端侧的 commands 通道、宿主侧的 `command.execute` RPC)。死表面不只是装饰:它告诉 SDK 与 UI 消费方一个关于什么会到达模型的、并不存在的 wire 行为。

同一条路由上,客户端与宿主的失败方向相反。fetch 载具给每个 unary 调用施加 30 秒传输截止并兑现 dispose/release abort,但 handler 在 `sessions.prompt` 到达网关之前丢弃了载具 signal,而 R5-B 的每会话操作槽又拉长了准入前的等待(prompt 可能排在一次 `selectModel` 或 preset swap 的 recompose 之后)。宿主停滞时,客户端报错并保留草稿,网关却仍然准入消息并开启轮次——composer 的重发于是把同一段文本投递了两次。

## 决策

同一条路由上的三个动作。

**删除死的契约表面。** `command?` 槽从 prompt 响应类型与 `sessionPromptValueSchema` 中移除;`command-error`/`unknown-command` 两行从 `RpcErrorDetailsMap` 与 wire error schema 中移除,闭合联合直接拒绝这两个码。Service Definition 的 JSDoc 现在陈述真实行为:以 '/' 开头的行按字面文本送达模型,命令执行绝不发生在这条路由上。

**转发载具 signal,且只在提交点之前兑现。** `UNARY_ROUTES` 把载具 signal 转发进 `sessions.prompt(request, signal)`。在串行化准入槽内,signal 在入口检查一次、在持久内容接收开始前再检查一次;任一命中都以 `cancelled` 应答,inbox 不会有任何内容。接收一旦开始,准入一律完成——准入非滚动,不存在半准入状态,也不回滚已落盘的图片对象。应答复用既有的 `cancelled` 码。

**按请求身份去重。** 网关为每个会话记录已准入 prompt 的 rpcId,放在一个有界的近期准入窗口里(固定 32,是记账边界而非部署可调项)。对已记录 rpcId 的再次准入以 `accepted` 幂等应答且不触碰 inbox;守卫按会话隔离——相同 rpcId 在另一会话上(fork/resume 谱系)照常准入。这在协议层让上述错配变得可安全重试。一个限度如实记录:现有 composer 每次 callUnary 都铸造新 rpcId,所以今天该守卫保护的是复用请求身份的调用方,而非 composer 自己的重发路径;客户端侧重试复用 rpcId 是 runtime session 的后续工作,不在本次变更的文件面内。

## 已考虑的替代方案

**以新错误码拒绝以 '/' 开头的 prompt。** 否决:用户完全可能想问一个以 '/' 开头的问题;agent loop 已在 pre-step 边界解释 skill token(按 skill catalog 契约、模型可见);拒绝方案会在刚埋葬一套命令词汇的 wire 上再引入第二套。

**滚动取消穿透持久接收。** 否决:图片准入按批次提交持久附件对象;批次中途 abort 需要逐对象回滚才能保持持久面一致,为这一个图片批次的窗口引入整套机制不值得。接收前取消是彻底的,接收后 prompt 必然送达——文档现在陈述的就是这个干净的二分。

**无界的 rpcId 历史。** 否决:重试只能与近期准入竞态,超出小窗口的保留什么也守不住,只会随会话增长。窗口边界保持为网关内的固定常量。

## 后果

`session.prompt` 的响应值是纯粹的 `{ accepted: true }`:旧对端多发的 command 键被 value schema 剥离,解析任一退役错误码现在在闭合联合处抛出。未开始持久接收的 aborted/超时 prompt 返回 `cancelled` 且 inbox 可证明为空;已开始的则把 `accepted` 回给一个可能已不再等待的调用方——客户端可见的注释(facade、Service Definition、apiproxy README)现在写的是"可能已送达",不再声称 abort 会终止 Host round-trip。相同 rpcId 的重复准入是单次投递的幂等 `accepted`。测试钉住:`rpc-schemas.spec.ts` 的 schema 反转,以及 `client-handler.spec.ts` 中一个真实网关块,覆盖逐字 '/' 准入、排队期 abort 取消(inbox 未被触碰)、接收开始后准入存活、按会话 rpcId 去重与跨会话豁免。本次变更之外:composer 的 promptError toast 文案可以把失败表述为"发送可能已送达"的产品话术;该文案位于 runtime session/InputBar 表面,属于其他 slice 的文件集。
