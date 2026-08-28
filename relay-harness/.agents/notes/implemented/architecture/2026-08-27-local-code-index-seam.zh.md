# Agent Note: 本地代码索引 seam 脚手架 —— provider 之前的检索词汇

Status: implemented

[English](2026-08-27-local-code-index-seam.md) | 中文

## Problem

本地代码索引能力需要先有 Service Definition，SQLite 存储、排序引擎、本地 provider 与工具 Consumer 才能在 schema 不翻动的前提下落地。该能力是三期计划（词法/grep 混合检索 → AST 符号图 → embedding 向量 + contextEngine evidence）的第一个增量，将 CodeCortex 的检索设计原生移植而非 MCP 外挂。若 seam 不先行，后续每个包都会发明各自的 wire 类型与 epoch/缓存语义。

## Decision

以 `@relay-harness/rlh-code-index` 开设 `packages/index/` 组：`ctx.codeIndex.status()` / `.refresh()` / `.search()`。契约要点：

- `EpochPair`（`indexEpoch` 每个已提交内容写事务恰好前进一次；`evidenceEpoch` 预留给语义证据摄入）进入第一版接口；消费方缓存必须同时键控两者。
- `RepoSizeTier` 常量只存在于 `src/tiers.ts`，从参考实现逐字移植（分档边界 500/5000/25000；top-K 5/10/15/20；输出字符 18000/24000/32000/38000）。
- 检索结果是确定性的（分数降序、chunk id 升序破平）、自我解释的（`reasons` token），并携带 `degraded` 标志——非空 `readErrors` 标记结果不可缓存。

Seam Config 刻意推迟到 provider 包——没有当前消费者的配置项违反无未用表面规则（knip 实际上强制了这一点），explore/graph/token 预算的分档表随其消费阶段落地时再加入。

## Consequences

每个新服务 seam 有六点目录登记清单：`SERVICE_PAGE`、`LINK_MAP`（[gen-cordis-catalog](../../../../scripts/gen-cordis-catalog.ts)）、`SERVICE_ROLES` 及其组顺序（[gen-doc-graphs](../../../../scripts/gen-doc-graphs.ts)）、type-equiv manifest、Model Experience 短句白名单与子系统目录 README 索引。抽象服务类必须直接定义在包入口（`src/index.ts`），config-catalog 分类器才能识别；定义在兄弟模块会把该包降级为"library"。

## Alternatives considered

- **类定义在 `service.ts`、入口再导出** —— 否决：config catalog 因入口不再默认导出抽象服务而把该包归类为"library"；声明跨文件重复也带来 coverage 问题。
- **seam 现在就带 Config** —— 否决：所有配置项（watcher、ignore 列表、db path 推导）的唯一消费者都尚不存在的 provider 中，load-time fail-loud 校验将无的放矢。
