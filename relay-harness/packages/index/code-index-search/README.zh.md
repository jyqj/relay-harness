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

`createSearchEngine({ port })` 返回同步的 `search(request)`，各阶段顺序固定：plan 构建阶段执行 preselect 折叠（`defaultPreselectLayers`：working-set/recent/pinned/overlay rank decay、FTS summary、逐 token 符号/路径匹配、带门控的 fallback），并按分档归一化 query、其 `path:`/`lang:`/`kind:`/`name:` DSL 过滤器（`parseDslLite`：`lang:` 经存储语言别名解析为 SQL 强制的 scope，未知名不过滤任何内容——与参考实现的 `Language::from_name` 一致；`kind:`/`name:` 在 finalize 阶段作用于候选的符号列）以及 top-K；启用的 lane（`createLexicalLane`、`createGrepLane`、组合装配时提供的 graph lane，以及末位的 `createLiteralLane`）按注册顺序串行执行；融合总分窗口截断到 rerank 窗口后经 port 批量取详情，套用可追踪的加法表（`overlap·0.35`、doc/prefix/working-set/recent/pinned/overlay 加成、`min(stage-a·0.04, 0.25)`），最后在分档输出字符预算内确定性收尾（DSL kind/name 保留阶段，随后分数降序、chunkId 升序破平）。

数值常量与公式逐字移植自参考实现的 `rrf.rs` / `preselect.rs` / `lanes.rs` / `plan.rs` / `fts.rs`；合并后的默认表见 `src/config.ts`。新增 lane 或 preselect 层通过 `defineRetrievalLane` / `definePreselectLayer` 注册——装配时校验 id 唯一且至少一条 lane 可用，绝不把问题留到搜索中途。可恢复的读取失败降级进入 `readErrors`（同时 `degraded=true`）而不是中止搜索，调用方可据此把部分结果排除出缓存，与 seam 契约一致。

## Model Experience

Indirectly, through the search results that `ctx.codeIndex.search()` hands to consumers in rlh-tool-code-index; prompts and schemas remain theirs.

#### KV Cache effect

不直接改变请求前缀；每个 hit 都自带 `reasons` token，Consumer 无需在对话内重新解释排序结果。

## Known Limitations and Deferred Work

- **graph 检索组件为组合式而非内建** —— graph lane 与 graph-neighbor 层由 `@relay-harness/rlh-code-index-graph` 提供，经 `defaultRetrievalLanes(graphLane)` / `defaultPreselectLayersForEngine(graphNeighborLayer)` 加入；以默认装配构建的引擎与引入 graph 前的行为逐字节一致，local provider 尚未切换到组合默认装配。
- **`symbol-exact` rerank 加成默认开启**（`FeatureGates.symbolExactEnabled`）：候选详情行携带所在符号名，加成作用于真实数据；不索引符号名的 adapter 可显式关闭该门。
- **`kind:`/`name:` 过滤器只作用于 chunk 级符号列** —— 没有存储 `symbol_kind` 的候选永远过不了 `kind:` 过滤；`name:` 只保留所在符号名包含该值的候选。
- **literal lane 需要存储侧的字面量镜像** —— `RetrievalPort` 缺少 `literalFtsCandidates` 的 adapter 保持 lane 禁用；SQLite provider 的 v3 schema 提供该镜像。
- **没有向量 lane** —— embedding 召回随 P3 语义证据阶段连同 `evidenceEpoch` 的写入方一起加入。
