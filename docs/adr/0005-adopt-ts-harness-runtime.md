# ADR-0005：采用 TypeScript Harness（relay-harness/）作为 Agent 运行时

- **状态**：已接受
- **日期**：2026-08-23

## Context

ADR-0001 与 ADR-0003 规定 agent 后端使用 Rust，并规划了 `relay-kernel` 等五个 crate 的 workspace（见 [`../engineering/tech-stack.md`](../engineering/tech-stack.md)）。该蓝图撰写时代码尚未开工。

现实情况是：仓库内 [`../../relay-harness/`](../../relay-harness/README.md) 已经存在一个成熟的 TypeScript Agent Harness monorepo（约 70 万行、280+ 个 npm workspace 包），具备完整的 Agent Loop、会话持久化与恢复、工具与 Skills、Subagent、权限与审批、计划模式、压缩、LSP、沙箱、CLI / Web / Electron 桌面端等能力，且带有覆盖率、快照、文档同步等成套质量门。从零开始的 Rust 实现将长期落后于这份已验证的实现。

## Decision

1. Relay 的 Agent 运行时采用 `relay-harness/`（品牌 Relay Harness，缩写 rlh）的 TypeScript monorepo，不再启动 Rust 内核开发。
2. ADR-0001 第 3 条（"后端使用 Rust"）与 ADR-0003 第 1、2 条（Rust、可复用内核库）在实现层面由本 ADR 取代；两个 ADR 的产品边界与 Agent Loop 语义结论继续有效。
3. Rust 蓝图中的模块职责按以下对应关系映射到 harness 包组：
   - `relay-kernel` → `packages/core`（session / system-prompt / tools / agent / agent-loop）
   - `relay-cli` → `apps/cli`
   - `relay-tools` → `packages/fs`、`packages/shell`、`packages/web`、`packages/skill` 等能力包组
   - `relay-store` → `packages/session`（persistence / projection / checkpoint）
   - `relay-router` → 待建：中转调度客户端仍未实现，是 harness 之上的 Relay 专属增量（见 ADR-0002）
4. 跨项目接口仍以 OpenAPI + JSON Schema 为权威（tech-stack 第 1 节结论不变）；调度侧仍是外部项目。
5. 命名统一为 `@relay-harness/rlh-*` npm scope、`rlh` CLI、`RLH_*` 环境变量前缀。`DEEPSEEK_API_KEY`、`api.deepseek.com` 等指向第三方模型 API 的厂商引用不属于品牌范围，保持不变。

## Consequences

- [`../engineering/tech-stack.md`](../engineering/tech-stack.md) 的 Rust workspace 章节降级为历史蓝图；实现层技术事实以 `relay-harness/docs/architecture.md` 为权威。
- 路线图 P0 中"Rust workspace 与 relay-kernel"等条目视为已由 harness 等价能力覆盖；真正的缺口是 Relay 产品语义（chat/work 双模式、Prompt Enhancing、中转调度客户端、模型强度展示），在 harness 之上以插件形式补齐。
- 本地验证、状态外置、显式文件上下文等原则（ADR-0003 第 3–6 条、ADR-0004）不因运行时更换而放宽，需在 harness 插件层逐项核对落实。
- Telemetry 遵循 ADR-0003 "不建设 agent 侧 Telemetry" 的方向：harness 的会话遥测默认 DISABLED，且不内置任何上报端点（端点只能来自 `RLH_TELEMETRY_OTLP_URL` 显式配置）。
