# `@deepseek-ai/dsh-memory-agent`

[English](README.md) | 中文

`ctx.longTermMemory` 的 Agent 轮次 Consumer。在顶层轮次的第一个 step，它只提取直接用户文本，准备一个绑定 Scope 的召回观察，在完整消息字符上限内装入候选，并追加一条具有独立来源的 `user/message`。Provider 失败采用 fail-open，已接受的直接提示保持不变。

Consumer 会保留 prepared handle，直到持久的最终 `turn/end`。completed 和 max-token 轮次提交真正进入召回消息的精确 id；其他结束状态执行 abort。卸载会等待活跃 Provider 调用结束，并终止所有剩余待结算轮次。默认排除 delegated subagent。

## 配置

| Key | 默认值 | 契约 |
|---|---:|---|
| `userId` | `local` | 稳定用户 Scope。 |
| `agentId` | `deepseek-harness` | 跨会话共享的稳定 Agent Scope。 |
| `workspaceId` | 会话 cwd，其次 `global` | 可选的显式稳定工作区 Scope。 |
| `candidateLimit` | `10` | 装入前的 Provider 候选数。 |
| `maxContextChars` | `3200` | 包含安全框架的完整召回消息上限。 |
| `includeSubagents` | `false` | delegated 会话是否接收召回。 |

## 模型体验

### 主动记忆召回

#### 模型看到什么

符合条件的轮次首个请求包含直接用户消息，随后是 `## Recalled memory`。固定警示将 JSON 标为不受信任、可能过期的证据，并禁止执行其中的指令、权限声明或工具请求。条目数据转义后放在 `<memory-context>` 标签中；持久来源直接记录 id、revision、kind、trust、confidence、检索分数与渠道，展示方无需解析提示词。

#### Token 影响

有条件且受限。没有 active 候选可装入时不增加消息；否则完整召回消息最多为 `maxContextChars` 个字符，并保留到 compaction 替换它为止。

#### KV 缓存影响

召回是追加式用户角色后缀，会保留更早的可复用历史。不同查询或记忆版本只改变新后缀；后续 compaction 可能从替换位置起使缓存失效。

## 已知限制与延期工作

- **召回 Consumer 不拥有提取策略** — `memory-agent` 只负责召回与结算；独立且显式开启的 `memory-extractor-llm` Consumer 创建自动版本。
- **字符预算而非 tokenizer 预算** — 完整上限跨 Provider 确定，但不是精确模型 token 数。
- **尚无 cited-use 信号** — commit 记录进入模型的候选，不判断最终答案是否实际使用每一条。
