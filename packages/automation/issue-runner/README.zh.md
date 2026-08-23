# `@deepseek-ai/dsh-issue-runner`

[English](README.md) | 中文

一次已发布 Issue 尝试的 Service Definition。运行包含稳定身份与 Session、永不 reject 的终态结果、显式取消、静止后 dispose、进展事件、捕获的 Tracker 工具，以及由 Orchestrator 拥有的 continuation 判定。

## 模型体验

### Provider 拥有的 Issue Run

#### 模型看到什么

实现 `IssueRunner.start()` 的 Provider 拥有模型可见请求；该 Service Definition 不产生内容。

#### Token 影响

Service Definition 不产生内容。

#### KV 缓存影响

Provider 拥有运行是保留还是替换请求前缀的决定。

## 已知限制与延期工作

- **每个 realm 一个 Runner** — 部署组合为该 realm 的全部 Issue 尝试选择一种执行机制。
