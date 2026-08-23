# 产品与工程路线图

> 阶段按依赖关系推进，不代表已实现能力。
>
> **状态说明（2026-08-23）**：运行时已改用 [`relay-harness/`](../../relay-harness/README.md) TypeScript Harness（[ADR-0005](../adr/0005-adopt-ts-harness-runtime.md)）。P0 中 Agent Loop、状态机、工具、checkpoint、权限门等条目已由 harness 等价能力覆盖；中转调度客户端与路由信号仍是缺口。

## P0：Rust Agent 基础

目标：建立可验证、可恢复的 Agent Loop，并用内部 CLI 作为工程入口。

- Rust workspace 与 `relay-kernel`；
- work 状态机、工具调用、本地验证和 checkpoint；
- 无项目 Work Context 与文件引入；
- SubagentSpec 与路由信号；
- 外部中转调度 HTTP/JSON + SSE 客户端；
- 本地权限门、审计和错误恢复。

P0 的 CLI 是工程验证入口，不代表最终面向普通用户的产品形态。

## P1：用户友好的产品 Alpha

目标：普通用户无需学习 Prompt、Project 或模型即可使用。

- Web 产品壳与 chat/work 入口；
- 输入框预提交 `Enhance` 按钮；
- 文件拖入、清单、摘要和产物区；
- 人话进度、最小澄清和高影响动作确认；
- 长期记忆 v1（实现路径需先完成专项设计）；
- 用户可见的模型强度和计费说明；
- chat 转 work、work 恢复和结果追问。

## P2：扩展能力

- 更多办公与专业 Skills；
- 浏览器和第三方连接器；
- 团队协作与共享资料；
- 云端长任务与多设备恢复；
- 更完整的记忆控制、导入和导出；
- 桌面端及系统级文件体验。

## 阶段门

- P0 → P1：核心 Agent Loop、文件上下文、验证和恢复通过端到端验收。
- P1 → P2：新手用户能在无教学情况下完成典型 chat/work 任务，且 Prompt Enhancing、文件引入和记忆不会制造明显误解。

