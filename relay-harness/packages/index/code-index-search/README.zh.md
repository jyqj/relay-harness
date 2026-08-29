# @relay-harness/rlh-code-index-search

[English](README.md) | 中文

`ctx.codeIndex.search()` 背后的检索域引擎：确定性的文件预选、lexical/grep/literal 检索 lane、RRF 融合与加法 rerank 表——全部是 [`RetrievalPort`](src/port.ts) 之上的纯逻辑。本包负责候选“如何排序”；行序、scope 过滤与解码预算由 SQLite 侧通过 adapter 承担，包内任何模块都不接触 fs、SQL 或时钟。port 同时声明了 `graph` 读取面（`GraphReadFacet`：符号种子、call-edge 行、度数、chunk 跨度、imports、完整逐文件边重载、导入方反向查询、已解析 re-export 目标、受影响测试、导出指纹、字面量），存储 adapter 今日即实现它。读取该面的 graph lane 与 graph-neighbor preselect 层位于 `@relay-harness/rlh-code-index-graph`（`createGraphLane` / `createGraphNeighborLayer`），该包依赖本包；它们经 `defaultRetrievalLanes` / `defaultPreselectLayersForEngine` 的扩展槽组合进引擎，因此本包无法硬注册它们——那会构成被禁止的依赖环。literal lane 读取可选的 `RetrievalPort.literalFtsCandidates` 镜像（已分类的 `literal_index` 行）；缺少该方法的 port 会让 lane 保持禁用，先于 literal 的 adapter 依旧合法。

本包是 code-index 能力的一部分：

| 包 | 角色 |
|---|---|
| `@relay-harness/rlh-code-index` | Service Definition：抽象服务、词汇类型、仓库规模分档常量 |
| `@relay-harness/rlh-code-index-search`（本包） | 检索域引擎：lane、preselect 层、RRF 融合、rerank/finalize |
| `@relay-harness/rlh-code-index-sqlite` | Service Provider：工作区扫描、增量 diff、实现 port 的 SQLite 索引 |
| `@relay-harness/rlh-tool-code-index` | Consumer：模型侧 search/status/refresh 工具 |

## Pipeline

`createSearchEngine({ port })` 返回同步的 `search(request)`，各阶段顺序固定。plan 构建把 primary text 与最多四条最新且不重复的 `conversationQueries` 组合，折叠 working-set/recent/pinned/overlay 等 preselect 层，并规范化 DSL 与分档 top-K；各 lane 按注册顺序串行运行。融合候选经 port 批量读取携带文件内容哈希、语言及真实 parser tier/confidence 的详情，rerank 产出完整顺序的加法 `scoreTrace`，finalize 再在分档输出预算内执行 DSL 保留和 score-desc/chunkId-asc 排序。chunk 源码只在 port 内参与打分，不进入 `SearchHit`；源码交付归 seam 的独立 hydration 操作所有。

数值常量与公式逐字移植自参考实现的 `rrf.rs` / `preselect.rs` / `lanes.rs` / `plan.rs` / `fts.rs`；合并后的默认表见 `src/config.ts`。新增 lane 或 preselect 层通过 `defineRetrievalLane` / `definePreselectLayer` 注册——装配时校验 id 唯一且至少一条 lane 可用，绝不把问题留到搜索中途。可恢复的读取失败降级进入 `readErrors`（同时 `degraded=true`）而不是中止搜索，调用方可据此把部分结果排除出缓存，与 seam 契约一致。

## Model Experience

Indirectly, through the search results that `ctx.codeIndex.search()` hands to consumers in rlh-tool-code-index; prompts and schemas remain theirs.

#### KV Cache effect

不直接改变请求前缀；每个 hit 都携带 `reasons` 与数值 `scoreTrace`，Consumer 无需重建引擎状态即可解释排序。

## Known Limitations and Deferred Work

- **graph 检索仍由组合拥有**——普通 engine 保持无 graph；local provider 显式组合 `@relay-harness/rlh-code-index-graph` 的 graph lane 与 graph-neighbor 层。
- **`symbol-exact` rerank 加成默认开启**（`FeatureGates.symbolExactEnabled`）：候选详情行携带所在符号名，加成作用于真实数据；不索引符号名的 adapter 可显式关闭该门。
- **`kind:`/`name:` 过滤器只作用于 chunk 级符号列** —— 没有存储 `symbol_kind` 的候选永远过不了 `kind:` 过滤；`name:` 只保留所在符号名包含该值的候选。
- **literal lane 需要存储侧的字面量镜像** —— `RetrievalPort` 缺少 `literalFtsCandidates` 的 adapter 保持 lane 禁用；SQLite provider 的 v8 schema 提供该镜像。
- **当前 vector recall 是有界精确扫描**——vector adapter 在 `vectorMaxCandidates` 内独立返回 generation-scoped 语义候选，再与前序 lane 候选的余弦重排合并并进入正常 RRF/reason/score trace。扫描触及上限时，lane 会把部分语义覆盖写入 `readErrors`，并把完整答案标记为 `degraded=true`，Consumer 不会将其缓存或当作穷尽召回注入。未来 ANN 通过 `VectorReadFacet.recallCandidates` 替换。
