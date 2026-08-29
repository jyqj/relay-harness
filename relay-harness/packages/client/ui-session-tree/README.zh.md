# @relay-harness/rlh-client-ui-session-tree

[English](README.md) | 中文

Web 与 Desktop 共用的原生工作区 Session Tree。`conversation.session.header.actions` 中的会话操作及共享 `shell.titlebar.trailing` 操作都会打开 root-scoped `shell.overlay`；切换当前 Session 不会让画布 remount。没有当前 Session 时，标题栏操作为 disabled。Overlay 读取全局 Session／Workspace snapshot，以不恢复 Agent 的方式分页读取 durable history，并只从当前日志及 `parentSessionId`／`seedLength` 推导卡片和连线。持久化 store 仅保存 viewport、卡片坐标、折叠选择、标签、过滤模式、查询和选择状态，绝不保存消息、标题或 lineage。

每个根 Session 形成一条 Turn 卡片泳道。fork child 不重复展示继承 seed，并把第一条 live Turn 连接到 `seedLength` 之前最后一条父 Turn。孤儿仍作为根展示；lineage cycle fail-soft，不丢 Session。tool call／result 通过 `callId` 配对并折叠进对应 assistant Turn，同时保留错误状态与结果文本。五种过滤模式为 `default`、`no-tools`、`user-only`、`labeled-only` 和 `all`；搜索结果保留完整祖先路径。

画布支持平移、缩放、持久化拖拽位置、完整子树折叠、定位当前 Session、打开 Session、从最新或历史 Turn fork、从 Turn 前重写、继续对话、新建 Session 与归档。fork cut 一律委托 `ctx.sessions.fork({ atSeq | beforeSeq })`；浏览器不复制 Host 的 Turn 边界策略。重写会在选中 Turn 前创建 child，并把替换文本发送给 child，源 Session 的 append-only 日志保持不变。

## 模型体验

间接影响：用户从 Tree 发送继续或替换消息时会走普通 Session prompt 路径。该包不新增系统提示、工具、上下文或自动模型请求；提交文本就是用户输入的内容，替换输入为空时使用选中的原问题。

#### KV Cache 影响

打开、过滤、加标签和整理 Tree 不影响提供方请求或 KV 前缀。用户主动 fork 会复用选中的 durable prefix；后续继续对话与 Chat 中的同一操作一致。

## 已知限制与暂缓事项

- 布局与标签使用浏览器 `localStorage`，不会跨设备漫游。
- 打开 Tree 时会按协议分页读取所有可见 Session 的完整 history。超大工作区后续需要 viewport 驱动的 history cache。
- 不自动执行 Pi 风格的 abandoned-branch summary。RLH 保留旧分支并从选中的稳定 Turn fork，不添加隐藏的模型可见上下文。
