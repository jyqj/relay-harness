# @relay-harness/rlh-host-plugin-inventory

[English](README.md) | 中文

当前 Cordis Loader 树的只读 Host 投影。`PluginInventoryGateway` 注册 `pluginInventory` 服务，并发布两个由 Typert 生成的直接 Remote：`pluginInventory/list` 与 `pluginInventory/capabilities`。每次调用都直接读取 `ctx.loader.entries()`，跳过结构性的 group 行，再按 Loader 顺序返回其余条目，并且只包含 Loader 条目 id、模块标识、有效启用状态与当前根 Fiber 阶段。

阶段为 `pending`、`loading`、`active`、`failed` 或 `unloading`；条目没有存活的根 Fiber 时则为 `null`。该快照刻意只表示调用当下：Loader 仍是唯一的生命周期权威，本包不拥有缓存、历史、来源模型、事件流或修改路径。公开 payload 类型位于 `./types`，Typert 生成由 `./typert` 与 `./remote` 导出的 Host 和 Client Remote 产物。

`pluginInventory/capabilities` 把已挂载的 Loader 树、Host 的工具注册表与随附的能力目录（`DEFAULT_CAPABILITY_CATALOG`）拼接成一份有效能力报告：对每个能力给出 `assembled`（已装配）/ `configured`（已配置）/ `healthy`（当前健康）/ `session-available`（会话可用）四级判定，并附上每条事实的来源证据，最后折叠为一个 `effective` 状态。折叠规则天然诚实——`installed`（仅安装）永远不会变成 `healthy` 或 `running`，因此挂载了但未配置 embedding endpoint 的 code-index router 报告为 `installed`，而非 `running`。同一个 `buildCapabilityReport` 构建器与同一份目录也支撑免启动的 `rlh --dump-capabilities` CLI dump；后者只有组合证据，运行时级别一律报 `unknown`。

该服务仅供 Remote 使用，刻意不声明同进程 Cordis `Context` merge。Client 包通过显式的 [`api-remotes`](../../api/remotes/README.md) 组合消费它，而不导入 Host 实现。

## 模型体验

无，因为这个仅限 Host 的清单投影不注册提示词、工具、消息或提供方请求。

#### KV Cache 影响

无；本包从不组装模型输入。

## 已知限制与暂缓事项

- **仅表示调用当下** —— 结果不包含持久的失败历史或订阅；只要不存在存活的根 Fiber，就会报告 `null`，而不区分其原因。
- **无来源与修改能力** —— 服务不识别条目由哪个 bundle、profile 或 override 引入，也不能启用、停用、添加或移除插件。
- **目录是固定允许清单** —— 报告只覆盖 `DEFAULT_CAPABILITY_CATALOG` 声明的能力；session 级别读取 Host 的全局工具注册表，而非按会话限定的工具集，受 preset 门控的上下文贡献（memory、code recall）尚未建模。
