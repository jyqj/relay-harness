# `@relay-harness/rlh-memory`

[English](README.md) | 中文

`ctx.longTermMemory` 与 `ctx.memoryExtractionQueue` 的 Service Definition。它们定义精确的用户／工作区／Agent Scope、追加式逻辑版本、持久 SessionEvent 证据、受治理的状态与信任、排序搜索、无副作用的分页治理列表、确定性冲突复核、canonical signal、幂等 outcome reconciliation、prepare/commit/abort 主机轮次结算，以及可跨重启恢复的自动提取 job。Provider 实现存储、检索与队列 Owner；Agent、提取与工具 Consumer 分别拥有自己的提示词和授权策略。

`MemoryEntry` 是当前物化视图。即使 `revise()` 或 `forget()` 改变该视图，Provider 也必须保留旧版本；两类请求都可以携带 `expectedRevision`，用于 Provider 原子的 compare-and-set 治理。`active` 条目要求 `user-stated` 或 `action-verified` 信任；candidate、disputed、superseded 和 tombstoned 状态保持显式，不能静默覆盖历史。

## 模型体验

间接地，通过 `@relay-harness/rlh-memory-agent` 召回消息、`@relay-harness/rlh-memory-extractor-llm` 辅助请求和 `@relay-harness/rlh-tool-memory` 工具调用产生影响。

#### KV 缓存影响

本包不发出请求内容；每个 Consumer 分别拥有自己的缓存影响。

## 已知限制与延期工作

- **尚无 Provider Registry** — 一个 Cordis realm 中只能有一个 `ctx.longTermMemory` Provider；部署通过组合替换 Provider。
- **尚无 embedding 契约** — Provider 无关搜索会暴露检索渠道，但语义向量配置留给后续 Provider seam。
