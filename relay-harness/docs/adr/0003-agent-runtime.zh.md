# ADR-0003：Agent Loop 与本地验证

[English](0003-agent-runtime.md) | 中文

- **状态**：部分被 0005 取代（Loop 与验证语义有效；Rust 实现决定失效）
- **日期**：2026-08-20

## Context

work 模式必须能持续执行、调用工具、处理中断并可靠交付。工具返回成功并不代表用户目标已经实现，但验证机制不应与模型路由耦合。

## Decision

1. 运行时实现采用 [ADR-0005](0005-adopt-ts-harness-runtime.md) 的 TypeScript Relay Harness；原 Rust 决定失效。
2. CLI、Web 与 Desktop 复用同一 Relay Harness 包和 composition；原 Rust crate 规划失效。
3. Agent Loop 固定为：理解 → 计划 → 行动 → 观察 → 本地验证 → 继续/交付。
4. checkpoint、权限审计、工具结果和验证证据保存在本地运行状态中。
5. 本地验证只决定任务终态，不上传、不训练、不参与路由。
6. Subagent 是受限执行单元，必须携带目标、边界、验收标准、文件引用和路由信号。

## Consequences

- 不建设 agent 侧 Telemetry、路由飞轮或毛利仪表盘。
- 状态恢复与验证是运行时必需能力，不是运营数据能力。
- 当前模块边界见 [`../architecture.md`](../architecture.md)。
