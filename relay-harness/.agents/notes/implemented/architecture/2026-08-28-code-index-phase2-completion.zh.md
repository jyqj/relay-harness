# Agent Note：代码索引 Phase 2 收官——AST 解析、符号图与 explore_code_graph

Status: implemented

[English](2026-08-28-code-index-phase2-completion.md) | 中文

## Problem

Phase 1 端到端交付了 chunk 核心（scan → diff → chunk → store → retrieve），但这项能力最终所服务的一切 AST 级素材仍然缺位：没有解析器产出 symbol、import、调用边或字面量；seam 的图词汇只是编译面；`SearchHit` 不携带任何图贡献；模型也没有办法提出结构化问题（谁调用它、改动会破坏什么、哪些测试覆盖这个文件）。Phase 2 必须把解析层、符号图、图感知检索与一个面向模型的图工具作为一次连贯交付落地，同时不动摇 Phase 1 的保证（确定性答案、epoch 配对、有界出口）。

## Decision

Phase 2 分九刀落地，每刀有自己的 Agent Note；本 note 记录收官交付面，以及横跨各刀、对参考实现（`codecortex` 的 cc-server/cc-search/cc-db）做出的刻意偏离。

- **交付面。** parser 包在九个 tree-sitter 官方语法 WASM 之上行走十个语言名（JS/TS 家族、Python、Rust 为 `semantic` 0.85；Go、Java、C/C++ 为 `tree-sitter` 0.7）；resolver 经固定的九步阶梯（`self_member` … `global_unique`，再加三个 fuzzy-signal 步）把未绑定调用边绑定进 `resolution_kind` / `resolution_confidence` / `resolution_strategy`；v2 图表把 symbol、import、调用边、引用、路径派生的测试边与逐字字面量存进与 chunk 核心相同的携带 epoch 递增的事务；脏传播在每个 pass 预算内重解析每次导出面变更的传递性 importer 闭包；检索运行 graph lane 与连通度 rerank（`searchWithGraphContext`）并配以 epoch 为键的结果缓存；seam 暴露覆盖 `relations` / `impact` / `tests` 的 `exploreGraph`，并以第四个工具 `explore_code_graph` 呈现。
- **sha256 派生 id 是对参考实现的刻意偏离。** symbol uid 对（文件, 限定名）做哈希，行漂移不改 id、签名变更才移动 id；参考实现按源码位置派生 id，导致每次重排版都搅动整个图。ref 与边的 id 出于同样的确定性理由对（文件, 名称, 行, 列）做哈希。
- **语法供给切换为官方 release 产物。** `tree-sitter-wasms@0.1.13`（参考实现的来源）携带 web-tree-sitter ≥ 0.25 拒绝加载的旧式 `dylink.0` 段；改为由 `resources/grammars/VERSION` 钉住九个 WASM 各自的上游 release URL 与精确字节大小。
- **不存在解析超时 API。** 参考实现经 tree-sitter 的中断钩子限制解析时长；web-tree-sitter 不暴露任何钩子。替代方案是结构性的：逐文件隔离（病态文件只产生一条 `parseErrors` 记录，绝不会卡死 pass）加上对残缺树的容错遍历。
- **与 cc 的端口/缓存差异汇总：** 检索端口按 seed 侧投影边行，且不带存储的 `resolution_strategy` / `resolution_confidence` 列（explore 以 resolution kind 推导置信度并省略 strategy 字段）；`findImpactedTests` 返回原始关联行，去重与排序留在调用侧；图结果缓存（32 条 LRU）以 epochs + 请求 + 限额 + 排名指纹为键，degraded 结果永不入缓存，而参考实现的缓存横跨整个 runtime；本地 provider 恒走图路径——空图退化为普通管线，无需可用性探测。
- **忠实投影优先于静默修复。** explore 答案包含 JS/TS regex 兜底 lane 产生的声明自环边；测试对只在增量 pass 重建之后才存在（全量构建不写）——二者都是读取侧如实呈现、而非遮掩的存储层事实。

## Alternatives considered

- **从富化的 node 视图派生探索边** —— 否决：富化是检索侧的预算消费者，探索需要自带封顶的 seed 侧行走，因此 provider 直接从图读取面装配答案（`src/explore.ts`）。
- **在探索答案中隐藏未解析调用边与声明自环** —— 本阶段否决：读取侧不应替解析器做二次判断；过滤属于做出抽取决策的那一侧。

## Consequences

这项能力现在端到端回答结构化问题：search 提升图连通的 chunk 并解释加成，`explore_code_graph` 在真实存储上行走 caller/callee、扫描带测试的影响面、把文件映射到测试，而每份答案仍然以 epoch 为键、有界且自我解释。REAL 组合测试测得 9 文件 fixture 首次全量索引的中位数为 5 ms（约 0.56 ms/file）。两处已知缺口被刻意保留：真实仓库目前会踩中解析写入侧的 UNIQUE 冲突（同一位置出现重复抽取记录，例如单行上的多条字面量行、重载对），在解析器去重之前已认证语料规模受限；端口边投影携带 `resolution_strategy` 之前，explore 的 strategy 字段保持缺省。
