# Agent Note：原生工作区 Session Tree

状态：已实施

[English](2026-08-21-native-session-tree.md) | 中文

## 问题

Web 客户端已经能从完整 Turn fork Session，durable header 也已记录 `parentSession` 与 `seedLength`，但第一方界面没有展示这张图。外部 Synapse 实验证明了工作区画布的价值：分支可见、平移缩放、折叠、当前 Session 同步和 Turn 卡片；但其 fixed `document.body` 控件、iframe／`postMessage` 桥、私有 HTTP 路由及第二份 Session 消息与 lineage JSON 绕过了客户端 slot 和 object layer。Pi `/tree` 还提供当前路径、历史分叉点、标签、过滤和从旧用户消息重写等有价值的导航语义；但其单文件 entry tree 无法替换 DSH balanced append-only Turn／Step／Tool 日志及跨 Session lineage，否则两套 parent 模型会扩散到持久化、SDK、projection 与恢复。

## 决定

`@deepseek-ai/dsh-client-ui-session-tree` 是原生浏览器插件。`conversation.session.header.actions` 条目及 root `shell.titlebar.trailing` 条目都会打开 root-scoped `shell.overlay`，因此选择另一 Session 时地图更新而不 remount；没有当前 Session 时标题栏条目为 disabled。所有注册都使用普通 slot injection，并随插件 fiber dispose。包内私有 controller 只拥有临时 open／anchor 状态；root store 只持久化 viewport、位置、折叠、标签、过滤、查询与选择。

Session 事实仍由原 owner 持有。`SessionSummary.seedLength` 把 `SessionHeader.seedLength` 透传到 list baseline 与 `host/session-added`；`parentSessionId` 继续表示父身份。画布读取全局 Session／Workspace snapshot，排除 archived Session，并包含隐藏 subagent 等 descendants；`session.history` 分页读取不会打开或恢复 Agent。child 只投影 seq 大于等于 `seedLength` 的事件；第一张 live 卡连接到 cut 之前最后一张父 Turn。缺失父节点退化为根；cyclic lineage 去掉 cyclic parent edge 但保留每个 Session。

每个 Turn 对应一张卡。直接 `source.kind=user` 文本是问题，其他 user-role context 只在 all-process 过滤中显示，assistant 文本是回答。tool call 与 result 通过 `callId` 配对，并以名称、结果文本与错误状态折叠显示。过滤模式为 `default`、`no-tools`、`user-only`、`labeled-only` 与 `all`；搜索和 labeled-only 保留祖先卡片，结果仍可导航。卡片在用户拖拽前使用确定性坐标，拖拽后由 store 持有位置。折叠隐藏完整 descendant graph，而非只隐藏下一 Session。

所有业务写入都委托现有服务。打开调用 `ctx.sessions.open`；历史分支调用 `ctx.sessions.fork({ atSeq })`；重写调用 `ctx.sessions.fork({ beforeSeq })` 后把替换文本发送给返回的 child；继续对话使用现有 Session prompt face；新会话与归档使用 `ctx.workspaces`。UI 不判断任意 seq 是否为合法 cut；Host fork policy 仍是唯一决策 owner。

## 考虑过的替代方案

**原样 vendor Synapse。** 拒绝。其 iframe、私有 transport、独立 theme 与重复 message store 绕过客户端 slot 与 object-layer 约定。

**注册 session-scoped `conversation.view`。** 对工作区画布拒绝。切换当前 Session 会改变 view scope 并 remount 地图；root overlay 能在 Session focus 移动时保留 camera 与 selection。

**新建另一套 lineage 数据库或 projection key。** 拒绝。lineage 是跨 Session 的 immutable header metadata；`session-projection` 拥有单 Session 日志派生值，persistence 与 SessionQuery 已拥有 live／cold header。

**在单 Session 文件采用 Pi entry `parentId`。** 拒绝。它会在 DSH Turn／Step balance 旁增加第二套顺序关系，并重复现有跨 Session fork lineage。历史导航用 child Session 表示，不移动 mutable leaf pointer。

**自动写 branch summary。** 本次不采用。进入模型的 summary 是 durable model-visible input，需要独立 Session event 与 request-assembly policy；Tree 导航不能注入隐藏上下文。

## 后果

Web 与 Desktop 共用一个原生 Tree 实现和普通 theme／slot 生命周期。删除浏览器布局存储只丢失展示选择；完整业务图从 Session summary 与 history 重建。fork prefix 保持提供方 KV 复用，因为 Tree 不修改提示或工具。重写保留源日志并创建可审计 child。

打开 Tree 当前以每页 100 条消息的协议页读取所有可见 Session 的完整 history，以完整图优先于部分 branch anchor。后续 viewport 驱动 cache 可以降低超大工作区流量而不改变 projection 约定。标签是随布局保存的展示 bookmark，不在浏览器 profile 间漫游。

## 测试

Host／client schema 与 manager suite 固定 `seedLength` 和 `parentSessionId` 的并行传输。纯模型覆盖继承 prefix 移除、tool folding、workspace descendants、archived 排除、恢复后精确 fork anchor、cycle fail-soft、折叠、标签过滤及搜索祖先保留。Slot 覆盖两处原生条目、controller handoff、fork 委托和 fiber dispose。组件覆盖 durable-history 加载、Turn 渲染、Session 打开、完整 Turn fork、标签持久化及 Turn 前重写并 prompt。assembled Web 测试覆盖 bundle 加载与可见 Session Tree 操作入口。
