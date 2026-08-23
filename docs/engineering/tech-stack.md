# Rust 技术基线（历史蓝图）

> **状态说明（2026-08-23）**：本文的 Rust workspace 方案已被 [ADR-0005](../adr/0005-adopt-ts-harness-runtime.md) 取代——运行时采用 [`relay-harness/`](../../relay-harness/README.md) TypeScript Harness。保留本文用于对照模块职责映射；实现层技术事实以 `relay-harness/docs/architecture.md` 为权威。

## 1. 已确认

- agent 后端使用 Rust。
- 中转调度是外部项目，本仓只实现接口客户端。
- P0 使用可复用内核库与单进程 CLI 工程入口，不先建设常驻服务。
- P1 Web 界面可以使用 TypeScript，但不得复制 Agent Kernel 业务逻辑。
- 跨项目接口以 OpenAPI + JSON Schema 为权威，不以 Rust 内部类型作为协议来源。

## 2. Rust workspace

```text
relay-kernel   Agent Loop、状态机、Context Ports、领域契约
relay-cli      P0 工程入口与调试交互
relay-tools    文件、终端、搜索等工具适配器
relay-store    本地 Work State、checkpoint、审计与 evidence
relay-router   中转调度 HTTP/JSON + SSE 客户端
```

P1 根据产品界面需要增加 `relay-api`，复用 `relay-kernel`。

## 3. 模块规则

- `relay-kernel` 不直接依赖 UI、数据库驱动或 HTTP 客户端。
- 工具、存储、调度和记忆通过 Ports 接入。
- 外部接口错误在适配层转换为稳定领域错误。
- 本地验证属于 kernel 流程，不属于 router client。
- 文件访问必须经过 File Context 与权限策略。

## 4. 组件方向

| 组件 | 方向 | 状态 |
|---|---|---|
| 异步运行时 | Tokio | 初步确定 |
| 序列化 | serde | 初步确定 |
| HTTP/SSE | reqwest + SSE parser | 初步确定 |
| 本地存储 | SQLite | `[待验证]` |
| CLI | clap | 初步确定 |
| 错误建模 | thiserror；应用边界 anyhow | 初步确定 |
| 日志 | tracing，仅本地运行日志 | 初步确定 |
| 测试 | cargo test + 契约夹具 | 初步确定 |

## 5. 明确不做

- 不在 agent 仓实现模型池、benchmark、成本权重或路由算法。
- 不建设 agent 侧遥测平台、训练数据管道或毛利仪表盘。
- 不让 CLI 形态反向限制最终普通用户产品体验。
- 不在 P0 提前引入分布式状态、消息队列或微服务拆分。

