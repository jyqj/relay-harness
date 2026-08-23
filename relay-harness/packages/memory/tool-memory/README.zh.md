# `@deepseek-ai/dsh-tool-memory`

[English](README.md) | 中文

Provider 无关的记忆工具。每次调用都从调用 Agent 派生精确的用户／工作区／Agent Scope；搜索和读取绝不扩大 Scope。写入通过工具资源意图按 Scope 串行化。

只有当 `evidence_quote` 精确出现在直接用户消息或成功工具结果中，`memory_remember` 才会激活记忆。没有该证据时，Provider 收到 `agent-proposed` candidate，主动召回会忽略它。`memory_update` 对内容更改和激活应用同一规则。`memory_forget` 必须从直接用户删除请求取得精确引文，才能追加 tombstone。记忆工具自身的结果、其他 `session_*` 投影以及 `skill` 输出属于派生状态，绝不能验证写入（与提取侧的来源排除一致），因此召回的记忆无法把自身洗白为新鲜证据。Provider 仍会独立执行 active trust、证据和 secret 拒绝。

## 配置

| Key | 默认值 | 契约 |
|---|---:|---|
| `userId` | `local` | 稳定用户 Scope。 |
| `agentId` | `deepseek-harness` | 稳定 Agent Scope。 |
| `workspaceId` | 会话 cwd，其次 `global` | 可选的显式工作区 Scope。 |
| `defaultSearchLimit` | `10` | `memory_search` 默认结果上限。 |

## 模型体验

### 记忆工具 schema 与结果

#### 模型看到什么

该 Consumer 存在时，请求工具目录包含 `memory_search`、`memory_read`、`memory_remember`、`memory_update` 和 `memory_forget`；精确 schema 由生成的[工具目录](../../../docs/tool-catalog.md#deepseek-aidsh-tool-memory)负责。搜索返回紧凑元数据与内容，读取返回完整当前条目，写入以 JSON 文本返回已提交的当前版本。

#### Token 影响

所属 preset 的每个请求都会携带五个 schema。工具结果只在调用后增加数据相关 JSON；搜索把每条结果内容压到 320 个 Unicode code point，并应用已配置的结果数量。

#### KV 缓存影响

插件配置和工具可见性不变时，schema 前缀稳定。调用和结果追加在此前缀之后；挂载 Consumer 或 restriction 变化会改变请求的工具 schema 区段。

## 已知限制与延期工作

- **精确证据引文** — 受验证的激活刻意要求逐字引文；改写内容会保持 candidate，直到其他可信 Consumer 审核。
- **尚无批量操作** — 每次写入创建一条聚焦的记忆版本；导入、导出和审核队列属于后续用户界面 Consumer。
