# `@relay-harness/rlh-issue-automation`

[English](README.md) | 中文

应用在 `rlh-base` 与 `rlh-web-app` 之后的 opt-in bundle layer。它组合 Tracker Registry 与 Linear Provider、仓库 Workflow 文件、本地 Issue Workspace、原生多轮 Agent Runner、持久化 Orchestrator、生成的 Remote namespace 和浏览器 Operator overlay。该层不进入默认 Web profile，因为它要求显式 Workflow 路径、Tracker Scope、凭据和隔离 Workspace 策略。

## 模型体验

### 组合后的 Issue Run

#### 模型看到什么

间接地，bundle 组合组件包所述的 `promptTemplate`、continuation 消息和捕获的 `linear_graphql` 工具。

#### Token 影响

组件包分别拥有任务规模提示词和固定 Tracker 工具 schema。

#### KV 缓存影响

一次活动 Issue 运行保持稳定 Agent Session 前缀；Host retry 会在保留 Workspace 的基础上创建新前缀。

## 已知限制与延期工作

- **Linear vertical slice** — Provider seam 是通用的，但该 bundle 有意先提供一个完整 Tracker 集成，而不是为每个 Vendor 提供浅层 Adapter。
- **单 Host Scheduler** — 在分布式 lease Provider 出现前，一个 Tracker Scope 只能运行一个活动 Orchestrator。
