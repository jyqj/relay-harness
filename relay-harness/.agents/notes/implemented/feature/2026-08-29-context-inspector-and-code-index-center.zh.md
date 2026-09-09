# Agent Note：交付 Context Inspector 与 Code Index Center

状态：已实现

[English](2026-08-29-context-inspector-and-code-index-center.md) | 中文

## 问题

Durable `context/prepared` trace 和 BuildExplain/index generation 状态已经存在，但用户无法检查。浏览器只渲染模型可见 context message，看不到 durable trace 中的归因、未采纳链接、freshness、verification、truncation 或 coverage。Code-index 维护需要内部调用，也没有文件/chunk/generation/积压视图、安全 reconcile、approval 门控重建或有界检索诊断。

## 决策

`@relay-harness/rlh-context-inspector` 注册全日志 Session Projection。它把准确的 `user/message` 事实和 `context/prepared` event 折叠为最近 50 个 step trace，保留已采纳链接、未采纳/被改写的空链接、证据 source/key/path/revision、why-used、freshness、verification、truncation 与 coverage。消息事实上限 500，预览上限 240 code point。浏览器插件占用 additive 会话头部 utility slot 并打开 modal drawer；Chat ownership 和消息渲染保持不变。

Code-index seam 新增 operator management projection 与 reconcile verb。本地 provider 报告文件/chunk 数、epoch、BuildExplain、Embedding generation identity、coverage、pending/running/failed job 与有界最近错误。`@relay-harness/rlh-host-code-index-center` 暴露 typed status/refresh/reconcile/rebuild/search Remote。Debug search 限制 500 查询字符、20 路径、top-K 20，绝不 hydrate 源码。重建要求 Host 收到准确 `REBUILD` token；Client 还独立要求在确认 modal 中输入它。

Code Index Settings 页面使用 connection-scoped 状态缓存，展示健康卡、generation、coverage/backlog/error、有界原始 BuildExplain、维护动作和紧凑 debug hit。Web composition 现在交付本地 provider、code-context contributor、Context Inspector projection、Host Remote 与两个 Client surface。Desktop 共享这份 Web build，不存在平行 desktop UI。

## 考虑过的替代方案

- **浏览器直接读取原始 Session event**——否决；原始窗口受分页约束且不属于公开 Session face，Host 全日志 projection 可跨分页与冷重开。
- **把字段加入 chat node**——否决；归因是 log-only 可观测性，会把通用 conversation rendering 耦合到 Context Engine 词汇。
- **暴露无守卫 force rebuild Remote**——否决；浏览器 bug 或陈旧点击可能在无明确意图时清空派生 store。
- **Hydrate debug-search snippet**——否决；Center 用于诊断检索且必须输出有界，源码 admission 仍属于 hydration seam。

## 后果

用户可以检查使用了什么、为什么使用、revision 质量、coverage 在哪里停止，以及哪些 proposal 没有进入模型。Operator 无需开发者工具即可观察并修复默认索引。Context projection 有意省略 50 条以前的 trace 正文。Center 现在会经 Workspace router 解析 Host Session cwd，因此其状态、调试搜索和维护操作都按 Session 分区，而不是隐藏的进程级 UI 状态。

## Session 归属的重建确认

索引中心使用框架提供的 `useSessions`，不在业务组件内手动订阅。确认保存打开时的 Session id，在渲染和派发前与当前选择比较。切换 Session 和重新打开都会清空口令：对工作区 A 的确认不能授权之后重建 B。该检查不会取消已经派发的 Host 操作。组件和缓存不再公开导出。

回归测试在 A 打开并输入确认，切换到 B，验证弹窗关闭、没有调用重建，且新确认口令为空、按钮禁用。真实 Cordis 注册测试通过假的回包验证 Remote 参数、缓存重置及作用域卸载。这些测试本身不证明组装浏览器中的 Session 切换。

## 状态缓存发布归属

每次未命中缓存的状态读取和维护请求都会取得私有的 Session 级发布标记。只有最新准入请求能填充该 Session 的缓存；finally 仅清理自己的标记。连接重置同时清除缓存值及待处理请求归属。迟到调用仍收到自己的回包，但不能重新填入已失效缓存，也不能覆盖之后准入的维护结果。失败会清理归属，不删除其他 Session 的缓存。状态读取还会等待本缓存对同一 Session 已准入的全部维护请求，并在派发前重新检查是否有新准入请求。成功和失败都会解除等待；后续状态获取绕过旧缓存。重置会撤销发布归属，但保留尚未完成的维护等待，因为它无法取消 Host 工作。不同 Session 保持独立。这不等同于跨客户端或跨 Session 的 Host 操作串行化。

五个失败回归用例复现了重置、强制读取、刷新、对账及重建之后旧状态重新填入缓存的问题。新增测试还验证最新请求失败后旧的待处理回包不能重新取得发布权，其他 Session 的缓存仍可用，后续重试会重新获取状态。

组装后的 Settings 目录浏览器场景现会打开重建确认、输入口令、取消并重新打开。它针对重新构建的官方客户端验证输入为空，并比较禁用确认按钮的内联 ARIA 快照，不派发重建。这覆盖重新打开及框架驱动的初始 Session 选择；确认打开期间切换 Session 的对抗性场景仍只由组件回归测试覆盖。

## 热重载期间缓存实例的生命周期

真实 Cordis 卸载已会拒绝从非活动上下文访问必需服务，但仅靠这一点不够：`fork.restart()` 会重新激活上下文，旧的等待状态读取可能在维护确认后继续派发。修复前，回归在卸载分支通过，在重启分支失败。

apply 作用域现在通过 effect 永久停用所属缓存实例。状态调用准入及维护等待之后、维护调用准入和搜索准入都会拒绝已停用实例。停用会清除缓存发布归属；未完成维护仍可结束并释放等待者，不取消 Host 工作，也不伪造回滚。新插件拥有独立可用的缓存。测试在真实卸载及重启前保留旧回调，完成受控 Remote 回包，验证没有迟到状态派发、后续调用被拒绝，且替代实例正常工作。
