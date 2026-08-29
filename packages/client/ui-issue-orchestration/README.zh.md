# `@relay-harness/rlh-client-ui-issue-orchestration`

[English](README.md) | 中文

Remote Issue Orchestration snapshot 的 Operator overlay。标题栏 badge 打开 running、retrying、blocked 卡片；Operator 可以 refresh、retry、release，并打开关联 Session。Observable source 由 `apply` 拥有；组件通过 Slot Renderer 注入的 hook 接收它。

## 模型体验

### Operator overlay

#### 模型看到什么

模型看不到任何内容；`shell.overlay` 为人类 Operator 呈现 Host Orchestration 状态。

#### Token 影响

零直接 Token。

#### KV 缓存影响

不改变请求前缀。

## 已知限制与延期工作

- **没有运行中取消按钮** — Tracker reconciliation 仍是正常停止 Authority；显式 Operator 取消需要独立 Host 命令和策略。
