# Relay

Relay 是一个面向普通用户的通用 Agent：用户只需用自然语言描述需求或引入文件，Relay 负责补全上下文、执行任务、验证结果并交付。

产品原则：

- **傻瓜式可用**：不要求用户理解 Prompt、项目、模型或 Agent 工作流。
- **chat + work**：chat 用于对话，work 用于持续执行任务。
- **无项目心智**：work 不要求先建项目；文件与文件夹作为一次 work 的显式上下文引入。
- **Prompt Enhancing**：用户提交前可主动点击按钮，基于当前上下文优化草稿，但不会自动提交。
- **长期记忆**：记住用户真正需要长期保留的信息；具体实现路径待专项讨论。
- **模型路由外置**：agent 只消费中转调度项目的接口，不设计其内部路由算法。

## 仓库结构与事实来源

- 仓库根目录是 GitHub、产品文档和治理入口；`.github/`、`docs/feature-status.json` 与 `scripts/verify-feature-status.mjs` 只在根目录维护。
- [`relay-harness/`](relay-harness/README.md) 是当前 TypeScript 实现 monorepo。源码尚未物理 flatten，但所有 CI、E2E、文档和发布 workflow 都从仓库根发现，并显式在该目录执行。
- 产品定位和功能状态以根 [`docs/`](docs/README.md) 为权威；运行时类型、包和生成目录以 [`relay-harness/docs/architecture.md`](relay-harness/docs/architecture.md) 及其 subsystem 目录为权威。
- [机器可读功能状态](docs/feature-status.json) 是“已发布／部分完成／计划中”声明的唯一状态表；CI 会核对默认 composition、Remote、UI、E2E 与文档证据。

- [Harness 实现](relay-harness/README.md) — Relay Harness（rlh）agent runtime 与 CLI/桌面/Web 壳层（[ADR-0005](docs/adr/0005-adopt-ts-harness-runtime.md)）
- [文档地图](docs/README.md)
- [领域上下文](docs/CONTEXT.md)
- [产品体验](docs/product/product-experience.md)
- [Agent 架构](docs/agent/overview.md)
- [当前架构决策](docs/adr/README.md)
