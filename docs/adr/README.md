# 当前架构决策

本目录只保留对当前设计仍有独立约束力的决策，不保存完整调整历史。

| 编号 | 决策 | 状态 |
|---|---|---|
| [0001](0001-product-boundary.md) | 傻瓜式通用 Agent；调度侧是外部项目 | 已接受（第 3 条 Rust 实现被 0005 取代） |
| [0002](0002-routing-and-strength.md) | 事前信号驱动外部路由；强度等级对用户可见 | 已接受 |
| [0003](0003-agent-runtime.md) | Rust Agent Loop；本地验证与路由解耦 | 部分取代（Rust 实现被 0005 取代；Loop 语义与验证原则仍有效） |
| [0004](0004-data-and-action-boundary.md) | 显式文件上下文、最小权限和本地状态 | 已接受 |
| [0005](0005-adopt-ts-harness-runtime.md) | 采用 relay-harness/ TypeScript Harness 作为运行时 | 已接受 |

新 ADR 只用于跨模块、长期稳定且存在真实替代方案的决定。普通功能修改直接更新其权威设计文档。

