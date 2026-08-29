# TypeScript 工程基线

[English](tech-stack.md) | 中文

> [ADR-0005](../adr/0005-adopt-ts-harness-runtime.md) 选择根目录 TypeScript Relay Harness monorepo。详细运行时架构由 [`../architecture.md`](../architecture.md) 维护；本页概述技术选择与依赖方向。

## 1. 已确认基线

- 运行时包与应用在受支持的 Node.js 版本上使用 TypeScript 和 ESM。
- Relay 调度侧是外部项目；本仓库只拥有其未来接口客户端。
- CLI、Web、Desktop 与 SDK 投影复用同一插件运行时，不复制 agent loop 逻辑。
- 跨项目接口以 OpenAPI + JSON Schema 为权威，不以内层 TypeScript 类型作为协议来源。
- Cordis composition 与包 manifest 定义运行时组装。

## 2. Monorepo 布局

```text
packages/    Cordis plugins grouped by domain and capability role
apps/        CLI, Web, and Electron Desktop product applications
python/      Python SDK and bundled runtime distribution
native/      Platform-native helpers and packages
examples/    Runnable compositions and integration examples
docs/        Product, architecture, subsystem, and generated references
scripts/     Repository gates, generators, and release tooling
```

## 3. 模块规则

- 核心运行时包不依赖产品 UI 实现。
- 工具、存储、调度、记忆与上下文能力通过各自拥有的 Cordis 服务和插件集成。
- 进程、网络、持久化与 wire 错误在所属适配器转换为稳定领域诊断。
- 本地验证属于 agent loop，不属于未来调度客户端。
- 文件访问必须经过显式 workspace/file context 与权限策略。

## 4. 组件方向

| 组件 | 方向 | 状态 |
|---|---|---|
| 运行时 | TypeScript + Node.js ESM | 当前 |
| Composition | Cordis plugin graph | 当前 |
| 持久化 | 本地 session/storage provider，包括由相应模块拥有的 SQLite | 当前 |
| 产品应用 | CLI + React Web + Electron Desktop | 当前 |
| 包管理与构建 | pnpm workspaces + TypeScript project references + tsdown/Vite | 当前 |
| 测试 | Vitest、Playwright、snapshot、契约 fixture | 当前 |
| 跨项目协议 | OpenAPI + JSON Schema + HTTP/JSON/SSE | 调度客户端 planned |
| 原生隔离 | `native/` 下的平台辅助程序与 sandbox 包 | 当前 |

## 5. 明确不做

- 本仓库不实现调度侧模型池、benchmark 权重、成本权重或路由算法。
- agent 侧不建设训练数据管道或毛利仪表盘。
- CLI 约束不会限制普通用户产品体验。
- 分布式状态、消息队列和微服务拆分不是默认运行时前提。
