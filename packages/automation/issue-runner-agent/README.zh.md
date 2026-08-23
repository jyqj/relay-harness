# `@deepseek-ai/dsh-issue-runner-agent`

[English](README.md) | 中文

原生 DSH Agent Runner。它在准备好的 cwd 创建一个 Session，在发布前安装捕获的 Tracker 工具，发送渲染后的 Issue 提示词，每轮后重查 Tracker eligibility，并在有界 continuation 轮次中复用同一个 Agent／Session。运行结果在 Agent dispose 后结算。

## 模型体验

### Issue 与 continuation 提示词

#### 模型看到什么

首轮看到仓库 Workflow 渲染后的正文；仅当 Issue 仍可执行时，后续轮次看到精简 `continuationPrompt` 指引。

#### Token 影响

首轮提示词随任务大小变化；每次 continuation 追加一条有界用户消息；捕获的 Tracker schema 在每轮都存在。

#### KV 缓存影响

Continuation 轮次扩展同一 Session 前缀。Workflow 或 Tracker 工具变化只影响未来运行。

## 已知限制与延期工作

- **Host 恢复后使用新 Session** — 持久化 Orchestration 重试会复用 Workspace，但创建新的 Agent Session；不会重建精确的 live Agent 状态。
