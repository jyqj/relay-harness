# @relay-harness/rlh-host-product-mode

[English](README.md) | 中文

共享 `simple`／`developer` 产品模式的 Settings-backed Host owner。Fresh profile 继承 `simple`；显式持久值在升级后保持。生成的 `productMode.get/set` Remote 让共享 Web client 在浏览器与 Desktop 中读取和持久化同一模式。

## 模型体验

### 不直接发起模型请求

#### 模型看到什么

什么都看不到。`ctx.productMode` 只控制浏览器与 Desktop 呈现；其 Remote 不会追加 Session 上下文。

#### Token 影响

为零。读取或持久化产品模式不会组装模型请求。

#### KV Cache 影响

无。模式变化不会改变模型请求或 cache prefix。

## 已知限制与延后工作

- 跨标签变化会在 reconnect／reload 时读取；专用 forwarded change event 延后。
