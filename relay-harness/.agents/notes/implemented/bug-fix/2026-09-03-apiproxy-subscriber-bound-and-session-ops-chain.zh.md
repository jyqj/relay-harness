# Agent Note: Apiproxy 订阅者缓冲上限与会话操作链

Status: implemented

[English](2026-09-03-apiproxy-subscriber-bound-and-session-ops-chain.md) | 中文

## 问题

三个缺口同根:API 网关在准入工作时,要么不复核所检查的状态是否仍然成立,要么不限制消费者能让它保留多少内存。

`events.mux` 订阅者的 `FrameQueue` 无上限地缓冲每一条会话事件。一个已连接但停滞的消费者——挂起的代理、TCP 零窗口——既不会 abort 也不会拉取,队列在流的整个生命周期内无界增长,同时这条死队列还留在广播集合里,持续保留之后的每一条事件。宿主内存成为攻击者的杠杆。

`agentPreset.select` 的 blank 守卫存在检查时序到使用时序的竞态。守卫在 swap 开头执行,但 `recompose` 是慢异步步;这个窗口内到达的 `session.prompt` 会在旧组合下开启轮次,而切换随后仍会提交落地——恰好产生守卫要防止的转录状态(user message 先于 `agent-preset/selected` 标记)。prompt 准入与模型选择都不在任何 swap 参与的串行链里。

冷列表 blank 探测先用 `coldBlankProbeMaxBytes` 检查工件物理大小,然后读取整份存储日志。stat 与读取之间,会话可以附加并开始增长;读取侧没有任何上限,配置的门槛可能被完全绕过。(阈值在 `readFrom()` 前检查而非由 persistence 强制——[有界空白验证决策](2026-08-13-bounded-cold-blank-verification.md)已接受 size 门为建议性质;本变更在不引入 persistence 原子性的前提下关闭最常见的增长来源。)

## 决策

**`FrameQueue` 增加字节预算。** 每条队列以 `maxBytes` 构造(配置 `muxStreamBufferBytes`,默认 8 MiB,经 `z.natural()` 校验),`push` 用 `JSON.stringify` 计量帧——SSE 层紧接着做同一序列化,这是对保留值唯一诚实的度量。使保留总量超预算的 push 会结束队列:越过预算的那一帧仍被投递,随后流干净关闭。队列绝不丢帧或截断单帧——静默丢弃一条增量会破坏客户端的增量折叠。终止是安全的,依据既有的客户端契约:随附 pump 把事件流关闭视为重连并重放基线,mux 重开时重放订阅基线、携带稳定 rpcId 的待答问题与审批、队列快照和任务基线。drain 从每帧 O(n) 的 `buffer.shift()` 改为 head 游标并在耗尽时释放缓冲,长期存活的订阅者空闲时零成本。

**单一的每会话操作链。** `presetSwitches`(按会话的 select)与 `imageAdmissionChains`(按 agent 的图片准入与模型选择)合并为一条按 SessionId 键的 `sessionOperations` 链。所有模式的 `session.prompt` 准入、`session.selectModel` 与 `agentPreset.select` 的状态检查与提交都在该会话的槽内执行,blank 守卫重新成为权威:prompt 无法滑入 recompose 的 await。叠加一道兜底——`recompose` 之后复核(blank 且 idle),若有绕过链的准入(直接 Agent 入口)已开启对话,以既有的 `agent-preset-locked` 拒绝。

**冷探测在 `readFrom` 前紧邻复核附加状态。** `summarizeCold` 接受 `isAttached(id)` 谓词(网关传入其活会话查找)。stat 期间发生的附加使探测跳过读取;该行照旧由活会话生成。

## 已考虑的替代方案

**溢出时丢帧或截断。** 否决:静默丢弃一条 assistant 增量会让客户端的消息折叠悄然失步;干净的流关闭加完整基线重放不丢失任何东西。

**在 SSE 层用 `desiredSize` 施加背压。** 否决:暴露面是被保留的队列而非线路;停滞的消费者同样不读 `desiredSize`。限制保留是攻击者无法绕开的唯一约束。

**只复核 blankness(保留两条链)。** 否决:同一场 prompt-mid-recompose 竞态可经每种模式到达 `session.prompt`,且 `selectModel` 参与同一准入排序;拆开的链会重新打开这些检查所在的交错窗口。

**让 size 门与读取原子化(persistence 层上限)。** 与有界验证决策一致,延后:它需要为一次探测优化引入 persistence 操作和后端契约。附加复核已移除现实的进程内增长来源;外部进程在同一毫秒窗口向冷工件追加仍属可接受的残余建议缺口,且该残余窗口内的读取仍受工件实际增长到的规模约束。

## 后果

停滞或缓慢的 SSE 订阅者现在被干净地断开,而不是撑大宿主内存;最坏情形是确实缓慢但存活的消费者经历一次重连,且可通过 `muxStreamBufferBytes` 按部署调节。preset swap 进行中提交的 prompt 现在排在 swap 之后(并在新组合下运行),不再交错;观察到对话已开始的 swap 以既有 `agent-preset-locked` 拒绝。stat 期间会话已附加的冷探测不再读取任何内容。纯文本 prompt 现按会话串行——此前两条并发文本准入可能交错追加;现在顺序即队列到达顺序。wire 字段、事件 schema 与快照均不变:受影响的转录仅在先前未定义交错的竞态场景中呈现不同的事件顺序。最初归因于这条链的 served-web 种子会话 e2e 失败,后来经 wire 插桩免责——switch 路径从不进入该槽——admission 排序由 `settles a prompt queued behind a slow swap with the swap committed first` 钉住;[错误归因 note](../testing/2026-09-03-seeded-session-switch-e2e-misattribution.md)持有修正后的归因与残余的客户端侧 flake。
