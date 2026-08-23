# `@relay-harness/rlh-issue-workspace-local`

[English](README.md) | 中文

本地 Provider：生成经过清洗且抗碰撞的目录 key，规范化 root 与目标路径，拒绝符号链接逃逸，保留复用 Workspace，清理新建后设置失败的目录，并通过 `ctx.subprocess` 运行有界 hook，同时以显式 `RLH_*` 环境字段传入 Issue 元数据。

## 模型体验

### 本地 Workspace 内容

#### 模型看到什么

间接地，`afterCreate` 和 `beforeRun` 创建的文件可供 Runner 工具使用。

#### Token 影响

没有直接请求内容。

#### KV 缓存影响

Provider 不改变请求前缀。

## 已知限制与延期工作

- **Hook 是受信部署代码** — hook 字符串由 shell 执行；Provider 对其设界，但不沙箱化其语义。
- **仅本地执行世界** — 远程 Worker 需要在远端文件系统中执行 containment 校验的独立 Provider。
