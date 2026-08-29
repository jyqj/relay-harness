# `@relay-harness/rlh-issue-workspace`

[English](README.md) | 中文

确定性 per-issue Workspace 生命周期的 Service Definition：无副作用定位、创建／复用、阻塞当前尝试的 `beforeRun`、尽力执行的 `afterRun`，以及终态删除。

## 模型体验

### 准备好的工作目录

#### 模型看到什么

间接地，Runner 使用 `IssueWorkspace.path` 作为工作目录执行。

#### Token 影响

没有直接请求内容。

#### KV 缓存影响

Workspace seam 不改变请求前缀。

## 已知限制与延期工作

- **VCS 策略由 Provider 拥有** — clone、checkout、reset 和依赖安装属于 Provider hook 或后续 VCS 专用 Provider。
