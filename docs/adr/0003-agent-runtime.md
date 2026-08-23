# ADR-0003：Rust Agent Loop 与本地验证

- **状态**：已接受
- **日期**：2026-08-20

## Context

work 模式必须能持续执行、调用工具、处理中断并可靠交付。工具返回成功并不代表用户目标已经实现，但验证机制不应与模型路由耦合。

## Decision

1. agent 后端使用 Rust。
2. P0 采用可复用内核库与单进程 CLI 工程入口；后续产品界面复用同一内核。
3. Agent Loop 固定为：理解 → 计划 → 行动 → 观察 → 本地验证 → 继续/交付。
4. checkpoint、权限审计、工具结果和验证证据保存在本地运行状态中。
5. 本地验证只决定任务终态，不上传、不训练、不参与路由。
6. Subagent 是受限执行单元，必须携带目标、边界、验收标准、文件引用和路由信号。

## Consequences

- 不建设 agent 侧 Telemetry、路由飞轮或毛利仪表盘。
- 状态恢复与验证是运行时必需能力，不是运营数据能力。
- Rust 模块边界见 [`../engineering/tech-stack.md`](../engineering/tech-stack.md)。

