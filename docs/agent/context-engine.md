# 本地 Context Engine

## 当前状态

Context Engine 已在 [`relay-harness/packages/context/`](../../relay-harness/packages/context/README.md) 原生实现。代码检索由 monorepo 内 [`packages/index/`](../../relay-harness/packages/index/) 提供，不依赖仓库外的 CodeCortex checkout。完成状态及证据见 [`../feature-status.json`](../feature-status.json)；确切协议与限制见：

- [`relay-harness/docs/subsystems/context-engine.md`](../../relay-harness/docs/subsystems/context-engine.md)
- [`relay-harness/docs/subsystems/code-index.md`](../../relay-harness/docs/subsystems/code-index.md)
- [`relay-harness/docs/subsystems/memory.md`](../../relay-harness/docs/subsystems/memory.md)

## 产品约束

1. 文件、Session、Memory、MCP Resource 与代码索引各自保留事实源；索引只是可删除重建的派生缓存。
2. 检索结果先成为绑定 revision 与来源的 Evidence，再进入模型请求。
3. Source 内容不具指令权威；外部资源标记为不可信内容。
4. 检索失败、索引降级、coverage 不足和 budget 拒绝必须可见，不得伪装成“无结果”。
5. 不同 Provider 的原始分数不直接跨域比较；准入由 Context Engine 的排序与预算规则决定。
6. Recall 与系统注入不得重新升级为独立事实，避免派生内容自放大。
7. 用户显式选择的 workspace 决定 Code Index 路由和隔离边界。

## 当前能力

| 领域 | 当前实现 |
|---|---|
| 文件上下文 | 显式引用 hydration、大小预算、missing/stale 处理 |
| Session 历史 | 已完成 Exchange、checkpoint 与有界历史投影 |
| Memory | trust、冲突、outcome、usage coverage 与治理型准入 |
| Code Index | workspace router、词法/图/可选向量 lane、generation/epoch、脏闭包降级与管理中心 |
| MCP Resources | 仅显式 URI hydration，保留 text/blob framing 与不可信来源标记 |
| Prompt Enhancement | 与 Agent step 共用 Context Engine contributor，不维护第二套 composer |

## 隐私边界

索引、派生数据库和向量存储保留在本机。默认 Web composition 未配置 embedding endpoint，因此索引构建不出机；管理员显式配置可选语义 lane 后，有界代码 chunk 会发送给该 endpoint 生成 embedding，并计入 provider usage。无论是否启用语义 lane，都不会上传索引库或全量 workspace；最终 Context 仍只发送通过 Evidence 与 budget 准入的内容。

## 后续范围

- 用稳定本地 eval corpus 持续校验 recall quality、latency 与退化行为；
- 深化用户可见的 coverage、Evidence 与 index generation 解释；
- 外部模型路由客户端落地后，把 embedding lane 的模型调用纳入同一用户可见路由契约。
