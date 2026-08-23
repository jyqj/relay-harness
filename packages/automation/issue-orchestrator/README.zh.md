# `@deepseek-ai/dsh-issue-orchestrator`

[English](README.md) | 中文

持久化单写者 Scheduler。每次 tick 会 reload last-known-good 策略，先对账 running 与 blocked Issue，再 dispatch；每个候选项都按 ID 重验；执行全局与 per-state capacity；在 Workspace 或 Agent 副作用前持久化 claim；检测事件静默；应用有界指数退避；保留 blocked 状态；并把 Host 中断运行恢复成排队重试。

Storage-domain 记录是跨重启事实源。Live handle 和 timer 只是投影：重启不会假装恢复未知进程，也不会忘记 claim、Workspace、attempt 或 blocker。

## 模型体验

### Dispatch 拥有的模型工作

#### 模型看到什么

捕获的 `IssueWorkflowPolicy` 和所选 `IssueRunner` 决定模型可见工作；Scheduler 自身不产生内容。

#### Token 影响

没有直接内容；所选 Consumer 拥有任务和 continuation Token。

#### KV 缓存影响

没有直接内容；retry 会创建新 Session，运行内 continuation 则保留同一 Session 前缀。

## 已知限制与延期工作

- **单进程 Authority** — 持久状态可跨重启恢复，但多 Host active/active 调度需要带 compare-and-set ownership 的 lease backend。
- **没有 dead-letter 终态** — 重复失败会继续有界退避重试，直到 Tracker 策略变化或 Operator 释放。
