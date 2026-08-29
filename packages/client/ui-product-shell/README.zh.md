# Client Product Shell

[English](README.md) | 中文

Chat、Work、Library 的共享浏览器产品壳。

Simple Mode 会隐藏高级 model/preset/plugin/trajectory control，但保留 Context Inspector provenance surface。Work 读取既有 Goal、Plan、Jobs、Trajectory、Deliverables、Approval、Question 与 Session projection；Library 打开既有 Files 与治理 Settings surface。Deliverable link 在导航前会规范化并限制在当前 Session workspace 内。

## 模型体验

### 不直接发起模型请求

#### 模型看到什么

模型不会看到来自本包的内容。`productMode`、Work 与 Library 只是既有 Host 与 Session 状态的浏览器投影。

#### Token 影响

为零。更改产品壳不会追加 Session event，也不会准备模型上下文。

#### KV Cache 影响

无。产品壳只改变可见控件与导航，不改变模型请求或 cache prefix。

## 已知限制与延后工作

- 当前沿用侧边栏作为顶层导航宿主；Work 与 Library 是紧凑侧边栏页面，而不是独立中心栏路由。
- Product mode 暂无 Host push event；写成功后本地折叠，重连时重新读取持久值。
