# `@relay-harness/rlh-issue-orchestration`

[English](README.md) | 中文

持久化 Issue Automation 的可 Remote Operator snapshot 与命令 Service Definition。Snapshot 分开呈现 running／claimed、retrying 和 blocked；`refresh`、`retry`、`release` 是显式命令。

## 模型体验

### Operator 状态

#### 模型看到什么

模型看不到任何内容；`ctx.issueOrchestration` 是 Operator／查询服务。

#### Token 影响

零直接 Token。

#### KV 缓存影响

不改变请求前缀。

## 已知限制与延期工作

- **Provider 拥有授权** — Service Definition 不决定哪些传输主体可以调用 Operator 命令。
