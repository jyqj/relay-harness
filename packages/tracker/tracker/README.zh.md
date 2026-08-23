# `@deepseek-ai/dsh-tracker`

[English](README.md) | 中文

Tracker 读取和 Provider 原生工具的 Provider Registry。Provider 通过 effect 注册；轮询解析当前 Provider，而 `bindTools()` 为一次 Agent 运行捕获完全一致的 Provider／配置／工具快照以及凭据环境变量别名元数据。移除 Provider 会阻止新工作，但不会撤销已捕获的 binding。

## 模型体验

### 捕获的 Tracker binding

#### 模型看到什么

间接地，Runner 可以在 Agent Scope 中注册捕获的 `TrackerToolSpec` 值。

#### Token 影响

本包不产生提示内容；Consumer 决定捕获的工具 schema 何时进入请求。

#### KV 缓存影响

Binding 在一次运行中稳定；后续捕获可能产生不同工具前缀。

## 已知限制与延期工作

- **Provider 选择属于部署策略** — Registry 不会在 Provider 间自动选择，也不会合并它们的 Issue 身份。
