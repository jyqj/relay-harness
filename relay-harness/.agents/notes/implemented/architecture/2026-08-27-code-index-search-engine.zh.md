# Agent Note: 检索域搜索引擎 —— 以纯逻辑承载 lane、preselect、RRF 与 rerank

Status: implemented

[English](2026-08-27-code-index-search-engine.md) | 中文

## Problem

今天落地的 `ctx.codeIndex` seam 只定义检索词汇，不拥有排序机制；SQLite provider 与工具 Consumer 若没有第三个包把公式集中一处，就无法共享同一套确定性排序。把常量摊到 provider/consumer 各自实现，会让每个调用点分叉出不同行为——这正是参考实现用 `cc-search` 集中解决的问题（lane 注册表、preselect 层、RRF、rerank 表）。

## Decision

落地 `@relay-harness/rlh-code-index-search`，作为跑在最小 `RetrievalPort` 之上的检索域引擎：数值常量与公式逐字移植参考实现（`rrf.rs`、`preselect.rs`、`lanes.rs`、`plan.rs`、`fts.rs`，以及 `SearchConfig`/`RankingConfig` 默认表），Rust 并发折叠为串行执行，因为注册表顺序本身就是确定性融合顺序。关键契约：

- grep 扫描预算在 port 边界上拆分职责：store adapter 拥有行序与 scope 过滤，引擎侧拥有预算计数、两段式（prefilter/全扫）合并与截断判定。
- 可恢复的读取失败降级进入 `readErrors` + `degraded`，而不是中止搜索；装配期注册表校验 fail-loud，坏的 lane 组合到不了任何一次搜索。
- preselect 逐文件账单之和等于该文件总分，rerank trace 总和等于 hit 分数——两者都针对真实 fixture 断言，同时顶替纯存储类不变量关系的空缺。

P1 有两处刻意收窄：在符号数据出现前只解析 `path:` DSL 过滤器；`symbol-exact` 加成放在显式开关之后，而不是被静默丢弃。

## Consequences

排序行为从此只有一个家：改 `src/config.ts` 里一个常量就改变所有阶段；新增 lane/layer 不需要触碰 plan 或 engine 文件。确定性的代价继承了下来：JS 浮点顺序必须永远保持参考实现的加法次序，因此 `rerankCandidate` 内部即使代数等价的重构也属于行为变更。解码行的 scope 复查与 store 侧过滤刻意保持冗余——并发写入与批量取数之间的漂移不允许泄入结果。

## Alternatives considered

- **把排序折进 SQLite provider** —— 否决：P3 向量 lane 以及未来任何 provider 都得各自重实现融合/rerank，常量会按后端分叉，而不是收敛在一张配置表里。
- **保留 Rust 线程分组机制**（`reads_prior_scores` 分组）—— 否决：串行执行下分组不可观测，保留它只是假装保住并行性的死脚手架。
