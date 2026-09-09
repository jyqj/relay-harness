# SQLite runtime

[English](README.md) | 中文

`@relay-harness/rlh-sqlite-runtime` 负责惰性同步加载 Node 内置 SQLite。数据库 schema、事务、连接和关闭生命周期仍由调用方适配器负责。

## 约定

`loadNodeSqlite()` 在成功加载后缓存内置模块。它仅在同步加载内置模块期间过滤完全匹配的 SQLite 实验性稳定性提示，其他警告均原样委托。返回或抛出前会恢复 `process.emitWarning`。加载失败后仍可重试。导入此包不会加载 SQLite。

## Model Experience

无，因为此工具包仅加载 Node 内置模块；所有工具与存储约定均由调用方负责。

#### KV Cache 影响

无；此包既不组装也不发送模型请求。

## 已知限制与延期工作

- **仅负责初始化** — 此 helper 不隐藏数据库错误、不过滤后续警告、不改变 Node 对 SQLite 的稳定性保证，也不协调数据库所有者。它依赖仓库支持的 Node 版本提供 `process.getBuiltinModule`。
