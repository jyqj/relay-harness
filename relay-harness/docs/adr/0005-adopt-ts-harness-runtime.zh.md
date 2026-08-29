# ADR-0005：采用 TypeScript Relay Harness 运行时

[English](0005-adopt-ts-harness-runtime.md) | 中文

- **状态**：已接受
- **日期**：2026-08-23

## Context

ADR-0001 与 ADR-0003 曾选择 Rust agent 后端，并规划了包含 `relay-kernel` 的五个 crate workspace（见 [`../engineering/tech-stack.md`](../engineering/tech-stack.md)）。该蓝图撰写时尚无实现。

仓库根目录实际包含成熟的 TypeScript Relay Harness monorepo，已经提供 agent loop、会话持久化与恢复、工具与 skill、subagent、权限与审批、计划模式、压缩、LSP、沙箱、CLI/Web/Electron 应用，以及成套覆盖率、快照和文档门禁。从零开发 Rust 实现会长期落后于这份经过验证的运行时。

## Decision

1. Relay 采用根目录 TypeScript monorepo 作为 agent 运行时，品牌为 Relay Harness（`rlh`），不另行启动 Rust 内核实现。
2. 本 ADR 在实现层取代 ADR-0001 第 3 条（“后端使用 Rust”）与 ADR-0003 第 1、2 条（Rust 与可复用内核库）；两者的产品边界和 agent loop 语义继续有效。
3. Rust 蓝图中的职责映射到当前包组：
   - `relay-kernel` → `packages/core`（session / system-prompt / tools / agent / agent-loop）
   - `relay-cli` → `apps/cli`
   - `relay-tools` → `packages/fs`、`packages/shell`、`packages/web`、`packages/skill` 等能力包组
   - `relay-store` → `packages/session`（persistence / projection / checkpoint）
   - `relay-router` → 尚未交付：Relay 调度客户端仍是 harness 之上的产品专属增量（ADR-0002）
4. OpenAPI + JSON Schema 继续作为跨项目接口的权威，保留 tech-stack 第 1 节的结论；调度侧仍是外部项目。
5. 命名统一使用 `@relay-harness/rlh-*` npm scope、`rlh` CLI 与 `RLH_*` 环境变量前缀。`DEEPSEEK_API_KEY`、`api.deepseek.com` 等第三方模型 API 厂商引用保持不变。

## Consequences

- [`../engineering/tech-stack.md`](../engineering/tech-stack.md) 描述当前 TypeScript 基线；[`../architecture.md`](../architecture.md) 是实现架构权威。
- Rust workspace 路线图事项已由 harness 等价能力取代；Relay 专属完成声明继续由 [`../feature-status.json`](../feature-status.json) 治理。
- ADR-0003 第 3–6 条和 ADR-0004 的本地验证、状态外置与显式文件上下文仍约束插件层。
- Telemetry 遵循 ADR-0003 的方向：会话遥测默认 DISABLED，且不内置上报端点；端点只能来自显式 `RLH_TELEMETRY_OTLP_URL` 配置。
