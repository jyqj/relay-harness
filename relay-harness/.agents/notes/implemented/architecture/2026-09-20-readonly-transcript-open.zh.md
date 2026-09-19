# Agent Note: 不激活 Agent 的只读转录打开

Status: implemented

[English](2026-09-20-readonly-transcript-open.md) | 中文

## 问题

打开既有会话的转录，与在其中开始或继续工作，共用同一个 client 服务动词 `ISessions.open`。这一服务面没有区分只读查看与工作会话打开，只想查看转录的 consumer 只能沿用继续工作所用的路径；而「冷会话保持未物化」这一保证只存在于 host 侧的实现细节中，既没有 consumer 可以依赖的契约，也没有测试可以钉住它。

## 决策

新增 `ISessions.openHistory(sessionId)` 作为显式的只读转录打开：它像 `open()` 一样写入当前选择，并在历史窗口安装完成后返回；其契约是只发出非激活的 `session.history` 读取——绝不调用 `session.create`，也没有 prompt 或队列流量。在 Host 侧，`session.history` 对已附着会话从内存服务、对冷会话走持久化检查（`historySourceFor`），因此 client 侧的这一接缝加上一条 host 侧守卫测试即可钉住整条路径：冷打开不物化任何 Session 或 Agent，不做任何恢复，也不启动输入处理。直播跟随不需要单独的附着协议：Host 只为它已在运行的会话推送事件，冷窗口天然是快照；而活会话被动收到尾随帧，并不是这条路径触发了运行。ui-product-shell 的 Work、Library 与 record 源会话导航使用 `openHistory`；开始/继续工作的流程继续使用 `session.create`，其语义不变。

## 已考虑的替代方案

**单独的只读视图运行时。** 对象层已经用同一历史页渲染冷窗口（`openState`、projection 播种、向前翻页）；第二条转录管线只为省下一次选择写入，却要复制一套会话组装。

**让 `open()` 本身承诺不激活。** 那会把工作台打开冻死在「打开时不得附着或恢复」上，也无法给 consumer 一个书面的两种意图之区分。

## 后果

`ISessions` 加宽了一个方法，test-support 的 sessions 替身随之实现它（像 `open` 一样记录、立即返回）。`openHistory` 返回 promise，而 `open` 保持同步无返回值；忽略该 promise 的 consumer 保持今天的即发即忘行为。从冷的只读窗口继续工作仍然需要用户显式发送，它走 live resolver（`session.prompt`），激活本就属于那里。

## 验证

`api-proxy-cold.spec.ts` 证明 Host 半边：在完整 proxy、agent registry 与冷恢复 lookup 都挂载的情况下，对一条持久化会话调用 `session.history` 能服务日志，而 `ctx.agents.resume`/`ctx.agents.create` 未被调用，也没有任何 Session 或 Agent 物化。`sessions-service.client.spec.ts` 证明 client 半边：`openHistory` 写入选择、在窗口安装后返回、只发出 `session.history`（绝不 `session.create`）、重复打开不重拉，并对未知 id 保持响亮失败。
