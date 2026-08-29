# Client Product Shell

Chat、Work、Library 的共享浏览器产品壳。

## 模型体验

- 全新状态默认 Simple mode，并从 Host `productMode` Remote 读取。
- Work 从当前会话既有投影组合 Goal、Plan、Jobs、Trajectory、Deliverables 与 Approval 摘要。
- Library 打开真实 Files surface，或已注册的 Memory、Skills、MCP、Code Index 设置页。
- Developer Mode 恢复模型、Agent preset、插件、轨迹、Context Inspector 与原始诊断入口，不卸载其业务插件。

## 已知限制

- 当前沿用侧边栏作为顶层导航宿主；Work 与 Library 是紧凑侧边栏页面，而不是独立中心栏路由。
- Product mode 暂无 Host push event；写成功后本地折叠，重连时重新读取持久值。
