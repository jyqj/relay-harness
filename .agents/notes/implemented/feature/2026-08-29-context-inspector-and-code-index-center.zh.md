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
