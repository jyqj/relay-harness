# Agent Note: Persistence write-path teardown — one composite effect, an admission fence, and a retried retirement

Status: implemented

[English](2026-09-03-persistence-write-path-teardown-ordering.md) | 中文

## Problem

持久化协调器的拆卸契约是"事件接纳先于最终 drain 到达静止并关闭后端而关闭"，但实现并不拥有这一顺序。drain effect 与四个 `session/*` 监听器是同一 fiber 上的独立顶层 effect，而 Cordis 以并行方式拆卸一个 fiber 的各 effect（`Fiber._unload` 用 `Promise.all` 映射每个 disposable），注册顺序在该层面不提供任何保证。接纳先于 drain 关闭，只是因为每个 disposer 恰好都是同步的、微任务队列恰好先运行监听器移除再运行 drain 的首次后端写入。组内未来任何异步 disposer 都会重新打开一个静默丢单窗口：drain 期间入队的事件落入一个只能在 `backend.close()` 之后写入的 write-behind 批次。

同一拆卸还有第二个卡死状态。最终 flush 失败的 retirement 只告警即遗忘：retirement 记录被删除，而该生命周期的 live 条目与滞留批次仍在，缓冲事件永远无法 drain，该 session id 也永远无法复用——之后的同 id create 会被误导性的 "already bound to a different live session" 碰撞错误拒绝。

## Decision

**一个复合 effect 拥有整个写路径。** drain disposer 与 `session/created` / `session/event` / `session/flush` / `session/disposed` 四个监听器被收集进单个 generator effect。在一个 effect 内部，Cordis 以单条串行链按收集的逆序拆卸所收集的 disposer，因此 drain disposer 最先 yield、最先收集、最后运行：无论 fiber 上还有什么，监听器移除都确定性地先于 drain。drain 体首语句置 `tearingDown`，`session/event` 监听器视其为接纳关闭——规避了移除的监听器不再入队任何批次，因为 drain 开始后接纳的批次只可能在 `backend.close()` 之后写入。

**失败的 retirement 再 drain 一次——仅一次——且总是释放。** 首次 drain 失败会记录错误、保持 retirement 记录挂起（同 id 读取因此等待其结果），并武装一次退避重试（`retirementRetryDelayMs`，默认一秒，后端提供时校验）。重试成功则正常释放该生命周期。重试失败也照常释放：永久失败的后端不能挟持该 id，且失败已在 retirement 处上报，拆卸 drain 不得第二次上报。因此 `retireWithRetry` 总是 fulfill；失败只通过日志与失败记录表呈现，绝不会成为无人观察的 rejection。当失败仍被记录且搁置 controller 仍有工作时，同 id create 以该底层写失败拒绝，而非碰撞文案；一旦重试排空或穷尽，该 id 即可复用（对已持久化日志做采纳，未持久化时全新创建）。dispose 时武装的重试计时器被清除——drain 自行 flush 同一搁置会话并拥有最终上报。

## Consequences

接纳先于 drain 的不变量不再依赖微任务调度：复合串行链即使在其兄弟 disposer 等待真实宏任务时也会移除监听器，`tearingDown` 栅栏覆盖病态的乱序情形。一个 dispose 顺序测试锁定 drain 首次后端写入时监听器为零的状态，旁边放一个其 disposer 推迟一个宏任务才移除自属监听器的兄弟 effect。retirement 的三种结局都有测试钉住：瞬时失败经重试干净释放并复用 id；永久失败被释放且只上报一次（dispose 保持干净）；搁置窗口内的重建以底层写失败拒绝。

代价：失败的 retirement 现在使该 id 的可用性延迟一个重试等待（以 `retirementRetryDelayMs` 为界）；两次尝试都失败时滞留事件丢失——它们本就不可写，另一选择是永远挟持该 id。重试计时器被并发 dispose 清除的 retirement，其 retirement promise 在余下进程生命周期内保持挂起，拆卸之后没有任何调用方能够观察到它。

## Alternatives considered

- **保留独立 effect、依赖注册顺序** — 现有代码的顺序真实但属偶然：它只在组内每个 disposer 保持同步时成立，而这正是插件生态无法承诺的性质。
- **在 create 碰撞分支内等待搁置 flush** — 死锁：`onCreated` 运行在 per-id serialize 链内，而搁置 controller 的写入会重入同一链条，恢复性 flush 因此等待正在等待它的调用方。重试在链外执行 flush，这正是恢复逻辑放在那里的原因。
- **重试直至成功** — 无界重试把一个死掉的后端变成永久的 per-id 热循环；单次退避重试既限制了工作量，又覆盖了搁置问题所指向的瞬时失败。
- **把 retirement rejection 作为等待方的错误** — 把首次失败传播给 `prepare`/`load` 等待方，使该 id 在一次瞬时错误后不可用；等待方现在等待重试结束后观察释放后的存储。
