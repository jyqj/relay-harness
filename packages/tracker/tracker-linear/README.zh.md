# `@deepseek-ai/dsh-tracker-linear`

[English](README.md) | 中文

`ctx.trackers` 的 Linear GraphQL Provider。它分页读取项目范围候选项、批量按精确 ID 对账、规范化标签／阻塞关系／负责人路由，并捕获由 Host 执行的 `linear_graphql` 工具。Linear token 只保留在 Provider 闭包中；binding 声明 token 环境变量别名，供子进程清理。

## 模型体验

### 捕获的 `linear_graphql` 工具

#### 模型看到什么

Issue Runner 安装 binding 时，模型会看到一个原始 `linear_graphql` 查询／变更工具。

#### Token 影响

Schema 添加固定工具定义；结果添加 Linear JSON 或有界错误。

#### KV 缓存影响

捕获的 schema 在一次运行中稳定；切换 Provider binding 会改变工具前缀。

## 已知限制与延期工作

- **原始凭据 Scope** — 工具可访问 Linear token 获准的全部资源；Workflow 策略负责变更纪律和幂等性。
- **没有 Provider 侧重试** — 传输、HTTP、GraphQL 和分页失败交给 Orchestrator 重试策略。
