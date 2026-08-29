# @relay-harness/rlh-code-index-graph

[English](README.md) | 中文

Relay Harness code-index 能力的符号解析层：内存符号目录加九步解析阶梯，把未解析的调用边与符号引用绑定到目标符号，逐字移植自参考实现的 `cc-index` resolver，置信度表、惩罚项与 DB 映射完全保留。`dirty/` 模块承载增量脏传播阶段：导出面指纹、不动点导入闭包、脏重载策略与提升编排。

本包属于 code-index 能力：

| 包 | 角色 |
|---|---|
| `@relay-harness/rlh-code-index` | Service Definition：抽象服务、词汇类型、仓库规模分层 |
| `@relay-harness/rlh-code-index-parser` | 解析层：文法加载、逐文件提取记录、分块 |
| `@relay-harness/rlh-code-index-graph`（本包） | 解析层：符号目录、九步阶梯、类型目录二次裁决、脏传播 |
| `@relay-harness/rlh-code-index-sqlite` | 存储仓库：schema、epoch 递增写入、检索端口适配器 |
| `@relay-harness/rlh-code-index-search` | 检索域引擎：预选、lane、融合、重排 |
| `@relay-harness/rlh-code-index-local` | Service Provider：`ctx.codeIndex` 背后的扫描/差分/分块管线 |
| `@relay-harness/rlh-tool-code-index` | Consumer：面向模型的 search/status/refresh 工具 |

## 符号目录

`SymbolCatalog` 把符号行登记进七个查找面——小写叶名、uid、限定名、限定名叶段、文件、按文件的嵌套名/限定名、按文件的导出——并回答阶梯与回退所需的查询：同文件名/限定名探测、导出解析、属主类上溯、五层成员链，以及 `find_best` 回退（唯一限定名，其次同文件，再到导入距离，受 `maxFuzzyPool` 上限约束，默认 256）。`removeFiles` 清理每个查找面、把删除镜像进内嵌类型目录，并以墓碑方式保留槽位不复用，使先前捕获的索引——包括记忆化结果——保持有效。`CatalogSliceCache` 把参考实现的跨构建目录复用表达为显式的按文件操作（`addFile` / `removeFile` / `invalidateFile`）；解析记忆化是以完整查询元组为键的 LRU，其行号分量仅在作用域存在时参与键，与参考实现的键守卫一致。

## 解析阶梯

`resolveName` 以锁定的顺序走阶梯——self 成员、作用域绑定、同文件、导入、后缀、全局唯一、模糊参数数、模糊接收者、模糊导入距离。self 成员步是权威的：`this.`/`self.` 前缀的名字在属主类上失配时中止整条阶梯，而不是落到无关的全局符号。模糊步共享一个在全局唯一步播种的按名候选池；信号步依次收窄（参数数证据含缺省参数层与无元数据通配层，再到接收者类型三态兼容），导入距离步对幸存者做决胜。置信度是精确的：种类基分从 1.0（exact）到 0.30（fuzzy-multi），候选数惩罚豁免三及以下，导入不可达的全局唯一胜者乘 0.6×，信号收窄与全不可达的模糊胜出再乘 0.5×。

## 入口 API 与纯度

`createSymbolResolver({ catalog, loadSymbolsForFiles? })` 返回的解析器以纯内存的 rows-in/rows-out 方式执行 `resolveEdges`：先回填空缺的 strategy/confidence 缺省值，永不覆写已带目标的行，在导入或作用域提供富上下文时走阶梯（否则回退到带 `same_file_fallback`/`global_fallback` 溯源的 `find_best`），在阶梯命中时记录 direct 派发与五分支调用分类，并输出按种类的绑定计数。未触碰的行保持对象同一性，改写的行是新对象。输出保留存储词汇：`import_resolved` 折叠为 `scope_resolved`，所有模糊/名字证据种类折叠为 `heuristic`，信号收窄的胜出写入 `fuzzy_arg_count`/`fuzzy_receiver` 策略覆写。

## 类型目录二次裁决

主过程之后，每条调用边都在门下二次裁决：exact/qualified/作用域已证的结果永不触碰，unresolved 与一般启发式结果被无条件覆写，名字证据结果（`global_unique`、`suffix`、`fuzzy_*`）可在不同目标以严格更高的置信度提出替换提案，并记录 `"{strategy}:upgraded_from={old}"`。提案来自内嵌类型目录，按固定优先级——类型赋值推断的接收者（0.90）、原始接收者类型（0.95）、唯一的参数数匹配（0.9）。

## 脏传播

`computeExportFingerprint` 对文件的导出符号做哈希（`uid|name|signature|exportName` 行、整行排序、SHA-256；无导出为 `null`），使增量构建只从导出面真正变化的文件开始闭包。`computeDirtyClosure` 将种子集按不动点扩展：每轮通过注入的查找找到种子文件的导入方，按排序提升可提升者，并在内层不动点中重新评估每个被提升文件的有效导出面（其已解析的 re-export 目标，经 `reexportTargetsChanged`），使同轮兄弟链仍能触达各自的导入方。提升预算跨轮全局且严格大于：首轮溢出保留预算规模的确定性前缀并报告 `budget_exceeded`；后续轮溢出保留已完成轮边界并报告 `partial_closure`；16 轮硬上限约束病态深链。结果按 `normal` / `partial_closure` / `budget_exceeded` / `disabled` 分类进入 pass 报告。

`runDirtyPropagation` 在已提交的存储上编排该阶段：比对写前指纹（调用方采集）与写后台账，把删除/改名路径并入种子，经闭包提升，为被提升文件同步解析器目录，并原位重解析其存量边——脏重载策略表声明每类边的处置（`symbols`/`imports` 保留，`callEdges`/`symbolRefs` 清除），穷举 switch 即编译期约束，`reloadEdgesForFiles` 经存储的 graph facet 读回存量行供 `reresolveDirtyFiles` 使用。

## 图检索 lane

`src/lane/` 承载检索侧的图消费方，移植自参考实现的 `cc-search` 图组件。`createGraphLane` 用查询的前五个 token 播种符号（不足 3 字符的 token 经两种常见大小写的精确名相等解析，更长 token 走子串种子查找，精确命中得 1.0、部分命中得 0.5；分数按最大值合并，种子场截断到 20），按 `seed × 0.5` 向两个方向扩展一跳调用边，把每个邻居 uid 映射回其最小包含 chunk，并按计划的 graph 限额截断。它按设计只参与融合：只喂 RRF 排名位置，不标注命中、不产出 reason，其 chunk 分数保持在 lane 内部。`createGraphNeighborLayer`（第 8 层，在内建 fallback 之后）用当前得分前 20 文件的一跳调用图邻居文件扩展 preselect 候选——缺席文件以 0.8 进入，每多一次边命中加 0.1、封顶 1.2，结果按剩余 preselect 预算截断并带 `graph-neighbor` reason。两者都读取 search 包 `RetrievalPort` 的 graph 面，且尽力而为：一条边读取失败只移除它自己的贡献，lane 的种子/chunk 映射失败则经引擎的 lane 守卫降级进 `readErrors`。组合后的引擎默认装配以 `defaultRetrievalLanesWithGraph()` / `defaultPreselectLayersWithGraphNeighbor()` 提供；注册顺序（lexical → grep → graph，graph-neighbor 在 fallback 之后）仍由 search 包持有，因为工作区依赖方向禁止反向导入。

`graphEnrich` 与 `searchWithGraphContext` 补全参考实现的图感知检索路径。`graphEnrich` 把最终 hit 解析到符号 uid（名字相等或行区间包含，uid 全局去重），按 `min(ln(in+out+1)/10 + min(refs,10)/100, 0.4)` 为每个解析到的 chunk 计分，并在分档图 token 预算内收集 caller/callee/test 上下文节点——预算触界时截断该节段剩余候选而非逐条跳过，每条失败的存储读取都降级进 `GraphExplainCollector` 信封（`"{op}: {error}"` 条目上限 8 并记录丢弃数，截断使用 `output_budget` 等稳定 token）。`searchWithGraphContext` 经 `RankingConfig.graphRerankWeight`（默认 0.3，reason `boost:graph-rerank`）把该分折入 hit，执行唯一一次最终排序（分数降序、chunkId 升序）并重排 rank，再按请求 top-K 截断（缺省取分档默认，`0` 映射为 10），结果按双 epoch + 请求哈希 + 全部富化限额 + token 预算 + ranking 指纹键入 LRU 缓存——降级结果（`readErrors` 非空）照常返回但绝不入缓。富化节点视图是本包的中间形态，面向消费者的投影留给后续阶段。

## Model Experience

### 已解析的图行

#### 模型所见

无。解析器是把存储行绑定到目标符号的库层；其 `resolution_*` 字段只有在 Consumer 包（code-index 工具及其图表面）通过自己的文档化表面渲染时才会到达模型。

#### Token 效应

零。本包没有任何文本进入模型请求；解析只是丰富索引已存储的行。

#### KV Cache 效应

独立：解析在索引刷新过程内运行，从不触碰请求前缀，因此这里不会使提供方缓存复用失效。

## 已知限制与延期工作

- **store 编排已落地，lane 经 provider 接线** — `store/` 把解析产物映射到存储写入面（`buildGraphDelta`、`graphRowsForOutcome`），决策并派发 test-edge 重建（`decideTestEdgeRebuild` / `applyTestEdgeRebuild`），并运行脏重解析流程（清除已解析目标、重解析、`writeResolvedEdges`）；脏传播阶段运行在 local provider 的增量 pass 内，不独立运行。
- **lane 与 enrich 路径已接线，节点投影未接线** — local provider 对每次检索运行组合默认装配与 `searchWithGraphContext`（空图时退化为普通结果），seam 的 `SearchHit` 已携带 `graphScore`；富化产生的上下文节点仍是中间视图，等消费阶段再投影为模型可见表面。
- **作用域是休眠接口** — 目前没有解析器产出词法作用域，作用域绑定步与作用域邻近排序保持惰性（`request.scopes` 通常为空）；接口为参考实现一致性而保留。
- **没有跨构建目录驻留** — 参考实现把整个已构建目录挂在经验证的种子令牌之后；本包只保留显式的按文件切片缓存，冷启动需要从 store 重建目录。
- **没有语义边与路由解析** — 参考实现的 `resolve_outcome` 还会解析语义边 UID 与路由处理器；本包没有这些行表面，故相应过程省略。
- **加载钩子是同步的** — `loadSymbolsForFiles` 必须同步填充目录（store lane 的 SQLite 读取是同步的，正好匹配）；异步加载器需要修订 API。
- **Phase 2 早期构建的库携带过时 id 值** — 逐次出现的 id 编码已变更，且 store 侧去重趟在 Phase 2 中途落地，早期构建写入的行保留旧 id 语义；此类库请用 `refresh({ forceRebuild: true })` 重建一次。
