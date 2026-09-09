# Agent Note：按规范 Session Workspace 路由并隔离 Code Index

Status: implemented

[English](2026-08-29-code-index-workspace-routing-and-isolation.md) | 中文

## Problem

Web bundle 只挂载一个以进程 cwd 为根的 `code-index-local` Provider。Context preparation、模型工具和 Code Index Center 因而没有 durable 方式选择 Agent 或 Session Workspace；Client 切换 Session 后可能继续收到进程级索引的状态或候选。Workspace hash 文件名只能避免默认路径碰撞，不能明确 runtime owner、请求路由、淘汰和 Remote scope。

## Decision

Code Index seam 新增 `forWorkspace(workspaceRoot)`，返回不可变的 Workspace 绑定操作面。显式 `code-index-local` Provider 会规范化并且只接受其配置根目录。新的 `code-index-workspace-router` 成为 Web/Desktop 默认 Provider：规范 `realpath` 是 registry key，每个 key 独占一个 `LocalCodeIndexRuntime`、watcher、invalidator、SQLite 文件、epoch ledger 和 Embedding generation 集合；全部未限定的进程级操作都会拒绝。

开放条目由 `maxOpenWorkspaces` 与 `idleEvictMs` 约束。操作持有 lease；LRU/idle eviction 只选择静止条目，先移除路由，再停止 timer/watcher，等待 Embedding drain，关闭 SQLite，并让并发 reopen 等待该关闭完成。工具结果失效使用产生事件的 Session cwd。数据库名称在配置目录下使用规范根目录 SHA-256 的 24 位十六进制后缀。

Code Context 以 `StepContextInput.cwd` 绑定一次，并用同一 face 完成候选搜索和 hydration。每个 code-index 模型工具以 `exec.agent.session.header.cwd` 绑定；刷新 busy set 按 Workspace key 分区。Code Index Center Remote 接收 `sessionId`，解析 Host 已附着 Session 及其 durable cwd，绝不接受 Client 文件系统路径。Client 状态 cache 按 Session 分区，Settings 页面订阅 Session 选择变化。

唯一注册的 Cordis effect 负责抑制重复清理；路由器的 disposed 标志用于关闭操作准入，而不是第二个清理 owner。工作区清理失败彼此独立：一个 disposer 失败不能导致其他 SQLite 句柄和 watcher 留存。关闭在全部选中条目结算后汇总失败。获取条目与保留 lease 之间存在异步恢复点。因此路由器在保留时校验已发布实例和关闭状态，并在并发淘汰后重试获取。更早找到条目并不允许在其离开路由表后继续使用。

## Alternatives considered

- **在每个 search/status/refresh payload 中增加 `workspaceRoot`**——拒绝，因为这会在全部词汇中复制 scope，并允许浏览器 Client 提交文件系统根目录；单一不可变绑定 face 也更难发生跨调用 hydration 漂移。
- **保留一个 runtime 并按请求切换 root/database**——拒绝，因为 cache、watcher、在途 refresh、Embedding drain 和 epoch 会成为 Workspace 间共享可变状态。
- **Host 生命周期内始终打开全部 Workspace**——拒绝，因为 watcher、SQLite handle、parser catalog 与 vector cache 会随历史 Workspace 数量增长。
- **按浏览器最近选择的 Workspace 路由**——拒绝，因为 Agent step、后台工具和多个 Client 需要 durable Session cwd，而不是全局 UI 状态。

## Consequences

两个真实 Workspace 可以并发索引和搜索，而不共享命中、chunk hydration、epoch、重建或数据库。Session 切换会选择单独缓存的状态与调试搜索。被淘汰 Workspace 重新打开 durable 派生 generation，不会仅因进程释放资源而重建。Headless 部署可以继续使用严格单 Workspace adapter。

Router 是进程内的；多个 Host 进程不会共享 LRU lease。精确 SQLite 操作在各独立 runtime 内仍是同步的，已删除 Workspace 在重新存在前也无法再次规范化。
