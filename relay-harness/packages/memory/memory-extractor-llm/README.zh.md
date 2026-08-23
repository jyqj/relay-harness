# `@relay-harness/rlh-memory-extractor-llm`

[English](README.md) | 中文

持久、证据约束的自动记忆提取器。completed 或 max-token 轮次结束后，capture 路径只把直接用户消息和成功工具结果投影为有界 source snapshot，再幂等写入 `ctx.memoryExtractionQueue`。Host worker 通过持久 lease 与 retry 领取任务，发起一次辅助 LLM 请求，严格校验其 JSON 提案，并经 `ctx.longTermMemory` 写入受治理版本。

包级默认关闭。发行的 base 组合仅对 `standard` 会话显式开启，并排除 delegated subagent。派生 recall/plugin 消息、reasoning、失败工具结果、memory/session/skill 工具结果以及含 secret 的来源一律不进入队列。allowlist 中本地工具的成功结果属于 `action-verified`；其他成功结果仍是 external observation。

只有当 `evidence_quote` 是直接用户消息或 action-verified 工具结果中的精确连续片段时，自动记忆才能成为 `active`；持久内容就是该精确引文，而不是模型改写。external 或无法 grounding 的提案保持 candidate；畸形输出会重试持久任务。按规范化 kind/content 做精确去重，使部分写入后的重试保持安全。

## 配置

| Key | 默认值 | 契约 |
|---|---:|---|
| `enabled` | `false` | 只有显式开启才注册 capture 与 worker。 |
| `userId` | `local` | 提取记忆的稳定用户 Scope。 |
| `agentId` | `relay-harness` | 跨会话共享的稳定 Agent Scope。 |
| `workspaceId` | 会话 cwd，其次 `global` | 可选的显式工作区 Scope。 |
| `agentPresets` | `[]` | 持久 preset allowlist；空数组接受全部 preset。 |
| `includeSubagents` | `false` | 是否捕获 delegated 会话。 |
| `provider`, `model` | 当前会话 route | 可选且必须成对出现的辅助 route override。 |
| `verifiedToolNames` | 本地文件／shell 工具 | 其成功结果可生成 action-verified 证据的工具名。 |
| `maxInputChars` | `16000` | system 与 user 合计的完整提取输入上限。 |
| `maxSourceChars` | `4000` | 每个来源的精确前缀上限。 |
| `maxCandidates` | `5` | 可接受的最大提案数。 |
| `maxCandidateContentChars` | `2000` | 提案内容上限。 |
| `maxCandidateSummaryChars` | `300` | 提案摘要上限。 |
| `maxOutputTokens` | `1200` | 辅助响应 token 上限。 |
| `timeoutMs` | `60000` | 提取调用的端到端 deadline。 |
| `maxAttempts` | `3` | 每个 source hash 的持久尝试上限。 |
| `leaseMs` | `120000` | worker claim lease；必须大于 `timeoutMs`。 |
| `retryDelayMs` | `5000` | 失败尝试后的延迟。 |
| `pollMs` | `1000` | 空闲队列轮询间隔。 |

## 模型体验

### 辅助记忆提取请求

#### 模型看到什么

一条独立的 `purpose: 'memory-extraction'` 请求包含固定的仅 JSON 指令，以及 tag-safe JSON 格式的有界 source snapshot 数组。每项包含来源类型、event seq、verification 类型、可选工具名和精确文本。模型没有工具，也不会收到对话历史、已召回记忆或 reasoning block。

#### Token 影响

辅助调用受 `maxInputChars` 与 `maxOutputTokens` 限制。它不会向主 Agent 历史添加文本；被接受的版本只能在后续轮次通过 `memory-agent` 召回影响模型。

#### KV 缓存影响

不会使主请求缓存失效。辅助请求只能复用 Provider 相关的固定 system 前缀；source JSON 会随每个已完成轮次变化。

## 已知限制与延期工作

- **单个进程内 worker** — job 可跨重启恢复，但发行的 SQLite Provider 只支持一个活跃进程 Owner，而不是分布式 worker。
- **字符预算而非 tokenizer 预算** — 完整上限跨 Provider 确定，但不是精确 token 数。
- **仅精确去重** — 语义等价改写需要后续 review 或语义 Provider 才能合并。
- **尚无 review 界面** — external 与无法 grounding 的 candidate 会持久保留，但需工具或后续 UI 才能晋升。
