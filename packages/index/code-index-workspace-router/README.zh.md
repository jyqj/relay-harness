# @relay-harness/rlh-code-index-workspace-router

[English](README.md) | 中文

`ctx.codeIndex` 的多 Workspace Provider。它规范化 Agent 或 Session 选择的 workspace cwd，为该身份打开独立的 `LocalCodeIndexRuntime` 和派生 SQLite 数据库，并返回不可变的 Workspace 绑定操作面。Web 默认组合使用本 Provider，不再绑定进程工作目录。

## 路由与隔离

调用方必须使用 `await ctx.codeIndex.forWorkspace(session.header.cwd)`。未限定 Workspace 的 `status`、`search`、`hydrateChunks`、`refresh`、`reconcile` 和图查询全部拒绝；路由器不会猜测最近活跃 Workspace。规范 `realpath` 会合并符号链接别名，SHA-256 Workspace key 则让每个 checkout 拥有独立数据库文件和 Embedding generation ledger。因此搜索命中、Hydration 身份、epoch、重建和维护状态都限制在选中 Session 的 Workspace 内。

`@relay-harness/rlh-code-index-local` 继续作为 headless 部署的显式单 Workspace Provider；它的 `forWorkspace` adapter 只接受配置的规范根目录。

## 生命周期

路由器在第一次操作时惰性打开 Workspace。`maxOpenWorkspaces` 限制保留的 runtime 数量；静止条目按 LRU 淘汰，`idleEvictMs` 关闭持续空闲的条目。活跃操作持有 lease。淘汰先从路由表删除条目，停止 invalidator 和 watcher，等待 Embedding drain，再关闭 SQLite；并发 reopen 会等待旧句柄关闭后再使用同一数据库路径。

工具结果失效按产生事件的 Session cwd 路由。可选递归 watcher 属于各自 Workspace 条目，不能调度其他条目的刷新。

## 配置

| 字段 | 默认值 | 含义 |
|---|---:|---|
| `databaseDirectory` | RLH home index 目录 | 保存 Workspace hash SQLite 文件的目录 |
| `maxOpenWorkspaces` | `4` | 最多保留的开放 Workspace runtime |
| `idleEvictMs` | `300000` | 静止关闭前的空闲时间 |
| `watcherEnabled` | `false` | 每个开放 Workspace 启动一个递归 watcher |
| `journalMode` | `wal` | 各 Workspace store 的 SQLite journal mode |
| `exclude` | `[]` | 所有 Workspace runtime 共享的附加忽略规则 |
| `maxFileBytes` | `512000` | 单文件索引字节上限 |
| `debounceMs` | `500` | 每 Workspace 工具结果失效 debounce |
| `dirtyPropagationMaxFiles` | `200` | 单 pass dirty closure 预算 |
| `embedding` | 关闭 | 共享 endpoint/generation 配置；向量仍按 Workspace 隔离 |

## Model Experience

### No direct model request

#### What the model sees

不直接可见。Agent 的 `code-index-recall` contributor 与 `search_code_index` / `explore_code_graph` tools 会先选择当前 Session cwd，因此既有排序片段、图答案、状态和刷新结果只来自该 Workspace。

#### Token effect

路由器自身不占 Prompt Token；Workspace 路由完成后继续使用既有搜索、图和 code-context 输出预算。

#### KV Cache effect

不改变 Prompt 前缀。Workspace 身份位于 Prompt cache 之外，各 Workspace 保持独立 index、embedding 和 evidence epochs。

## Known Limitations and Deferred Work

- SQLite 精确扫描在存储边界仍是本地同步操作；路由隔离 store，但不会降低单个超大 Workspace 的成本。
- `maxOpenWorkspaces` 是进程内资源上限，不是多个 Relay Host 进程间的分布式 lease。
- 已删除的 Workspace 不能重新规范化；已运行操作仍按删除前租用的身份完成。
