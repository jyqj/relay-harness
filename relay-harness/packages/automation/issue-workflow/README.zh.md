# `@relay-harness/rlh-issue-workflow`

[English](README.md) | 中文

仓库拥有的不可变 Issue Automation 策略版本的 Service Definition。Provider 暴露当前 last-known-good snapshot 和显式 reload 操作。

## 模型体验

### 捕获的策略版本

#### 模型看到什么

间接地，Consumer 渲染 `IssueWorkflowPolicy.promptTemplate` 和 `continuationTemplate`。

#### Token 影响

本包不产生内容；已提交版本只在 Consumer 捕获的位置生效。

#### KV 缓存影响

捕获版本使 Consumer 可以保持活动前缀稳定。

## 已知限制与延期工作

- **不合并策略** — 每个 Cordis realm 由一个 Provider 拥有一份完整策略文档。
