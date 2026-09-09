# Agent Note: session/subscribed 帧上的重连基线尾检查

Status: implemented

[English](2026-09-03-resync-subscribed-tail-check.md) | 中文

## 问题

客户端有一条为重连路径而写、却在该路径上永不触发的补拉分支。`doOpen` 拉取尾页后,若 `session/subscribed` 基线已到达且越过窗口尾部,会再拉一次拼接丢失区间;该谓词读取 `subscribedLastSeq`,而 `resync()` 在重建时把它置为 `null`——且在 resync(重连)路径上,新一代的 subscribed 帧不可能已经到达:`ConnectionController` 先跑 `host.describe`,再 await 完整的 `onConnected` hydration(正是它驱动 `resync`),之后才打开 mux 流。该帧严格晚于 `doOpen` 的检查,所以在重连场景这个分支是死代码。

后果不只是陈旧,而是静默丢尾。一次强制断流(`FrameQueue` 字节预算结束队列;SSE 客户端重连)会丢掉关闭窗口内发出的所有会话事件——重开的 mux 只重放基线(订阅、队列、任务、待答),从不重放事件。对这份丢失的唯一守卫就是那条永不触发的分支;若丢的恰是一轮的最后几条增量或 `turn/end`,会话窗口会一直停在陈旧尾部直到下一次 prompt,全程无任何报错。懒加载首开路径不受影响:那里流已在运行,用户打开会话时 subscribed 帧确实可能先于 `doOpen` 到达。

两条注释断言了与生产顺序相反的事实(onConnected 与 mux 帧竞速、"reconnect replays flow from stream open, ahead of onConnected"),`FrameQueue` 的保留契约则依据一次并不携带事件的"完整基线重放"宣称 "termination loses no state"。

## 决策

**窗口处于 open 时,`session/subscribed` 分支执行尾检查。** 与 `doOpen` 拼接拉取同一谓词(`frame.lastSeq > windowTailSeq()`,尾部非空):成立时调用既有的 `repairGap()`——即 resync-lite 尾页重拉,经 `installWindow` 落窗,复用 `stitching` 防重入守卫,且若期间被完整 resync 越代则丢弃结果。懒加载路径不动:`openState` 非 open 时分支只记录基线,`doOpen` 自己的第二次拉取仍是该场景的持有者。

**注释改为陈述真实顺序。** `resync` 注释说明 hydration 在开流之前完成,并指向 subscribed 帧尾检查作为关闭窗口丢失的守卫;`onStateChange` 注释删去方向颠倒的括注;`FrameQueue` 保留契约改为:重开只重放基线,窗口内事件的恢复路径是客户端的 subscribed 帧尾检查加补拉。

## 已考虑的替代方案

**让 resync 保留上一代的 `subscribedLastSeq`,并在 `doOpen` 落窗后补检。** 否决:它要把上一代的代号线索穿过重建传递,且对重建中途到达的帧仍需第二个检查点;subscribed 分支上的检查是单一位置,复用仓库已有的同一谓词。

**重排 `ConnectionController`,先开流再 await `onConnected`。** 否决:先 await 后 pump 的顺序正是为了让 unary 调用(会话列表、history)先于两条长连流占用 HTTP 池——握手处的注释记录了它防止的移动端 per-origin 槽耗尽。

## 后果

强制断流后的重连在新一代 subscribed 帧到达时立即补回关闭窗口内丢失的事件,而不是把陈旧尾部留到下一次 prompt;此前死代码的补拉分支在其预期路径上被真正行使。懒加载首开、未订阅会话(`subscribedLastSeq` 保持 `null`,走 liveBuffer 去重路径)与既有 doOpen 拼接拉取的行为不变。`session.client.spec.ts` 三个聚焦用例分别钉住补拉、低于尾部时的无操作、以及冷路径向 `doOpen` 的移交;方向修正后的注释只由评审约束,没有门禁强制。
