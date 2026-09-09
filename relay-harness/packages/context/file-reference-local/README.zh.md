# `@relay-harness/rlh-file-reference-local`

[English](README.md) | 中文

`ctx.fileReferences` 的本地文件系统实现。它为每个 agent（智能体）维护一个有界的 `WorkspaceFileSearch`，以该会话的 `cwd` 为根目录；缺少该值时回退到宿主进程的 cwd。查询包含 `/` 时，索引会对直接列出的目录项排序；否则会对有界递归索引进行模糊排序。索引永远不会跟随目录符号链接。

工具结果事件会使指定 agent 的可复用索引失效，使后续补全能够反映工作区中可能发生的变更。agent 的 dispose（资源释放）会释放该索引及其作用域内的提示词贡献；插件 dispose 会等待所有提示词 fiber，并释放全部缓存的搜索器。

当可选的 `fileContent` 配置段存在时，提供方还会注册一个 context-engine 步骤上下文贡献者（`file-reference-content`，经 `ctx.inject(['contextEngine'])` 晚绑定注册，因此 context-engine 保持可选）。它为每个步骤汇总已认领直接用户消息中的全部不同 `@file` 提及，并贡献一条携带这些文件只读快照的 `file-reference` recall 消息；没有提及的步骤不贡献任何内容。缺失、非常规文件或不可读取的提及会在消息与其 source 记录中以 `unavailable` 原因记录，而不是被丢弃。

## 配置

| 配置键 | 默认值 | 契约 |
|---|---:|---|
| `maxResults` | `20` | 单次查询返回的候选项最大数量。 |
| `maxEntries` | `10000` | 每个 agent 工作区建立索引的文件和目录最大数量。 |
| `excludedDirectories` | `[".git", "node_modules"]` | 遍历和候选项中排除的目录基名。 |
| `fileContent` | 缺省 | 该段存在才启用所提及文件的内容注入。 |
| `fileContent.maxFileBytes` | `65536` | 单个文件最多注入的内容字节数。 |
| `fileContent.maxTotalBytes` | `262144` | 单个步骤全部文件合计最多注入的内容字节数。 |

所有数值都必须是正的安全整数。排除名称必须是非空基名，且不能包含 `/` 或 `\`。该段缺省时不注册任何贡献者，文件提及仍是普通提示词文本；一旦总预算耗尽，该步骤中后续提及会被记为 `truncated`，原因为 `total budget exceeded`。

## 模型体验

### `read` 可用时的文件引用指引

#### 模型看到什么

当指定 agent 有实际生效的 `read` 工具时，提供方会贡献以下稳定的系统提示词段：

##### 文件引用指令

```markdown
Paths prefixed with @ are files explicitly referenced by the user. Use the read tool when their contents are needed; do not claim to have inspected a file before reading it.
```

#### Token 影响

该影响有条件且固定：只要 `read` 对指定 agent 可见，这一句就会存在；候选查询本身不增加 token，所选路径只会贡献普通用户消息中的对应字符。

#### KV 缓存影响

该稳定句子会加入系统提示词前缀。挂载或移除此提供方，或者改变 `read` 是否可见，都会改变该前缀；查询、候选项和索引失效不会改变前缀。

### 启用 `fileContent` 时的注入文件快照

#### 模型看到什么

在步骤已认领的直接用户消息之后，会出现一条以 `## Referenced file snapshots` 开头的 user 角色 recall 消息。它将内容定性为不可信的只读数据，并为每个不同提及包裹一个围栏代码块，块头部标注所提及路径、不同时的解析后路径、文件系统 revision 与截断标记；不可用的提及以原因替代内容。

#### Token 影响

按步骤与提及数量成比例：只有直接用户消息含 `@file` 提及的步骤会收到该消息，其大小受 `maxFileBytes` 与 `maxTotalBytes` 约束；没有提及的步骤不增加任何内容。

#### KV 缓存影响

recall 消息位于步骤已认领的用户消息之后，其内容不进入任何稳定前缀；调整预算或提及集合只改变该步骤的尾部。

## 已知限制与暂缓事项

- **宿主本地命名空间**：提供方扫描 Harness 宿主的文件系统，因此远程或虚拟 `read` 实现需要使用命名空间与该工具一致的提供方。内容注入经 `ctx.fs` 读取；缺少必需文件系统时抛出代码为 `CONTEXT_ENGINE_INVALID_CONTRIBUTOR` 的 `ContextEngineError`，不会转成 declined 或 degraded 检索 trace。
- **有界的提示性索引**：超大型工作区可能省略 `maxEntries` 之后的路径；被排除或无法读取的目录不会出现。
- **没有忽略文件语义**：`.gitignore` 和其他项目忽略文件不会影响发现；系统只排除已配置的目录基名。
- **仅文本快照**：二进制提及会记录为 `unavailable: FS_NOT_TEXT`；注入的内容不会在步骤开始后重读，模型获取最新或完整内容仍需使用 `read`。
