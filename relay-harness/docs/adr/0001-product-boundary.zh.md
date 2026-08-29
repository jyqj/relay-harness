# ADR-0001：傻瓜式通用 Agent 与系统边界

[English](0001-product-boundary.md) | 中文

- **状态**：部分被 0005 取代（产品边界有效；实现语言决定失效）
- **日期**：2026-08-20

## Context

目标用户不应被要求理解 Prompt 工程、项目结构、具体模型或 Agent 内部工作流。产品需要把复杂性收进系统，同时将模型路由与 agent 产品独立演进。

## Decision

1. Relay 定位为零学习成本、傻瓜式可用的通用 Agent，支持 chat 与 work。
2. work 是一次独立任务，不要求创建 Project。
3. agent 侧由本项目完整设计；实现语言由 [ADR-0005](0005-adopt-ts-harness-runtime.md) 决定为 TypeScript Relay Harness。本条原 Rust 选择不再有效。
4. 中转调度侧是独立项目；本项目只定义定性需求和版本化接口，不设计其内部算法。
5. 模型路由是基础设施能力，不作为用户必须理解的产品流程。

## Consequences

- 产品文档优先描述用户体验，再描述内部模块。
- 文件、记忆、Prompt Enhancing 都必须在无项目前提下成立。
- 调度内部的 benchmark、成本和运营权重不进入本项目的实现设计。
