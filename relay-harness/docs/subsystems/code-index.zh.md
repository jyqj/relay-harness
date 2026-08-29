# 本地代码索引

[English](code-index.md) | 中文

本地代码索引能力为当前工作区构建派生的磁盘索引，并向模型暴露确定性混合检索。它是一个[能力 seam](../../docs/glossary.md#capability-seam)，其 Service Definition（[rlh-code-index](../../packages/index/code-index)，`ctx.codeIndex`）报告健康状态、刷新派生索引并执行检索，但不规定任何内容如何存储、扫描或排序。索引是**一个可选能力**，不属于 agent-loop 主干——其词汇表在此记录，而不是在 [core.md](core.md)。

来源：[`packages/index/code-index/src/types.ts`](../../packages/index/code-index/src/types.ts)

## 包与角色

| 包 | 角色 | 接线 |
|---|---|---|
| [`rlh-code-index`](../../packages/index/code-index) | Service Definition：抽象 `CodeIndex`、词汇类型、仓库规模分档 | 声明 `ctx.codeIndex` |
| [`rlh-code-index-local`](../../packages/index/code-index-local) | 显式单 Workspace Provider：扫描、diff、切片和存储/检索 | 在 headless 组合中填充 `ctx.codeIndex` |
| [`rlh-code-index-workspace-router`](../../packages/index/code-index-workspace-router) | 多 Workspace Provider：规范路由、逐 Workspace runtime/database 和 LRU/idle 生命周期 | 在 Web/Desktop 中填充 `ctx.codeIndex` |
| [`rlh-code-index-sqlite`](../../packages/index/code-index-sqlite) | 存储仓库：SQLite schema、携带 epoch 递增的写入、检索 port 适配器 | 库，无服务 |
| [`rlh-code-index-parser`](../../packages/index/code-index-parser) | AST 解析：基于 web-tree-sitter 的 walker，把文件文本转成 symbol/import/调用边/字面量记录 | 库，无服务 |
| [`rlh-code-index-search`](../../packages/index/code-index-search) | 检索领域引擎：preselect 层、lexical/grep lane、RRF 融合、rerank | 库，无服务 |
| [`rlh-code-index-graph`](../../packages/index/code-index-graph) | 符号图领域：resolver 目录与阶梯、graph lane/富化、脏传播 | 库，无服务 |
| [`rlh-tool-code-index`](../../packages/index/tool-code-index) | Consumer：面向模型的 `search_code_index` / `explore_code_graph` / `code_index_status` / `refresh_code_index` 工具 | 注入 `tools` + `systemPrompt`，执行期经 `ctx.get('codeIndex')` 读取 |

Consumer 通过 `ctx.get('codeIndex')` 而非注入解析 seam，因此没有 provider 的组合可以正常加载，单个调用以结构化错误 `INDEX_TOOL_UNAVAILABLE` 失败。

## 数据流

一次刷新 pass 广度优先扫描工作区，用 mtime+size 快路径把每个文件与已提交世代对比（可疑者重读一次做哈希确认），然后运行五阶段管线——解析、解析绑定、写入、测试边重建、脏传播（后两者只在增量 pass 运行）。每个阶段的写入落在各自携带 epoch 递增的事务中，因此 pass 的 epoch 前进量恰好等于其提交次数。一次 search 经检索引擎的 preselect 折叠与各 lane——graph lane 与连通度 rerank 最后——读取存储的检索 port，把 epoch 对从存储账本读入答案，工具 Consumer 再在唯一出口边界上对完整序列化答案做上限裁剪，之后才进入模型上下文。

## Epoch

每个结果都在一个 `EpochPair` 下读取。`indexEpoch` 随索引内容事务提交推进，`embeddingEpoch` 随向量批次提交推进，`evidenceEpoch` 为未来运行时证据摄入保留。已审计提交必须恰好推进声明通道并冻结另外两个。seam 之上的缓存键包含所观察到的时钟快照；三个账本行以 `'0'` 播种、跨重启保留，缺失或不可解析时大声失败。

## 仓库规模分档

`RepoSizeTier`（`tiny` / `small` / `medium` / `large`，按已索引文件数划分）持有全部自适应常量。常量只存在于 `packages/index/code-index/src/tiers.ts`，唯一的例外是存储侧缓存容量，属于存储包自己的决定：

| 分档 | 文件数 | 搜索 top-K | 输出上限（字节） | chunk 文本缓存槽位 |
|---|---|---|---|---|
| `tiny` | < 500 | 5 | 18000 | 128 |
| `small` | < 5000 | 10 | 24000 | 256 |
| `medium` | < 25000 | 15 | 32000 | 384 |
| `large` | ≥ 25000 | 20 | 38000 | 512 |

snippet 预算在所有分档都是 `floor(output / 3)`，把 snippet 嵌入更大信封的消费者因此始终为包装元数据留有余量。

## 服务（`ctx.codeIndex`）

`status()` 无副作用地报告已索引文件数、解析出的分档、epoch 对、最近刷新摘要与 degraded 标志。`refresh(options?)` 把并发调用折叠为唯一在途 pass，只在该 pass 提交之后发布其 `RefreshSummary`。`search(request, signal?)` 返回携带内容 revision、parser 来源和加法 score trace 的排序候选；`degraded` 标志加非空 `readErrors` 表示结果不可缓存。`hydrateChunks(request, signal?)` 独立解析完整索引正文，重新哈希每个不同的当前源文件，并只以显式 rejection 返回过期、缺失或不可读的 identity，从而不让源码字节进入 search cache。`exploreGraph(request, signal?)` 在读取时 epoch 对之下回答五类图问题 `relations` / `impact` / `tests` / `cycles` / `dead_code`（见 [explore_code_graph 工具](#the-explore_code_graph-tool)）；每条边的两端都可解析到答案的 `nodes` 内。

```ts type-equiv
/** Model-shaped retrieval request against the local code index. */
interface SearchRequest {
  /** Raw search text; interpreted as identifier/path tokens plus free words. */
  readonly query: string
  /** Restrict ranking to these exact file paths (explicit scope). */
  readonly paths?: readonly string[]
  /** Files the model recently worked with; boosts their preselect score. */
  readonly recentPaths?: readonly string[]
  /** Files in the caller's active working set; boosts preselection and reranking. */
  readonly boostFilePaths?: readonly string[]
  /** Prior queries, oldest to newest; the latest four bias lexical retrieval. */
  readonly conversationQueries?: readonly string[]
  /** Caller-pinned context files; boosts preselection and reranking. */
  readonly pinnedFilePaths?: readonly string[]
  /** Dirty-buffer or overlay-neighbor files; boosts preselection and reranking. */
  readonly overlayFilePaths?: readonly string[]
  /** Restrict candidates to file paths starting with this prefix. */
  readonly pathPrefix?: string
  /** Requested hit count; the engine caps it by the repository-size tier. */
  readonly topK?: number
}
```

```ts type-equiv
/** Request for one ordered batch of full indexed chunk bodies. */
interface HydrateChunksRequest {
  /** Chunk identities to resolve; duplicates are returned once at their first position. */
  readonly chunkIds: readonly string[]
}
```

```ts type-equiv
/** Complete batch-hydration answer under one observed provider generation. */
interface HydrateChunksResult {
  /** Resolved chunks in first-occurrence request order. */
  readonly chunks: readonly HydratedChunk[]
  /** Requested identities rejected as stale or unavailable, in first-occurrence order. */
  readonly rejected: readonly ChunkHydrationRejection[]
  /** Epoch pair observed after the synchronous store read. */
  readonly epochs: EpochPair
}
```

```ts type-equiv
/** Model-shaped graph question against the derived code graph. */
type GraphExploreRequest =
  | {
    /** Walk callers and/or callees of one symbol. */
    readonly op: 'relations'
    /** Symbol name to resolve; providers disambiguate with {@link GraphExploreRequest.filePath}. */
    readonly symbol: string
    /** Pin the symbol to this file when several declarations share the name. */
    readonly filePath?: string
    /** Which side to walk; defaults to provider policy when omitted. */
    readonly direction?: GraphRelationDirection
    /** Walk depth; this phase supports `1` and `2`. */
    readonly depth?: 1 | 2
    /** Requested node/edge cap; the tier's graph-enrich limits still bound the answer. */
    readonly max?: number
  }
  | {
    /** Reverse-reachability sweep answering "what breaks if this changes". */
    readonly op: 'impact'
    /** Symbol to sweep; omit when {@link GraphExploreRequest.files} pins the seeds instead. */
    readonly symbol?: string
    /** Files whose reverse dependencies join the sweep. */
    readonly files?: readonly string[]
    /** Whether impacted tests join the answer. */
    readonly includeTests?: boolean
    /** Requested cap before tier limits. */
    readonly max?: number
  }
  | {
    /** Map code files to the tests that exercise them. */
    readonly op: 'tests'
    /** Code files to map. */
    readonly files: readonly string[]
    /** Requested pair cap before tier limits. */
    readonly max?: number
  }
  | {
    /**
     * Detect circular dependency components over the file-import graph
     * (iterative Tarjan SCC; components of size 1 — including self-imports —
     * are not cycles and never surface).
     */
    readonly op: 'cycles'
    /**
     * Requested component cap. Components order by size descending before the
     * cap cuts, so truncation always keeps the largest cycles.
     */
    readonly max?: number
  }
  | {
    /** List symbols with no incoming callers and no external references. */
    readonly op: 'dead_code'
    /**
     * Requested item cap. The candidate scan runs a bounded superset
     * (`min(40 × cap, 5000)` symbols) before the cap cuts the answer.
     */
    readonly max?: number
  }
```

## 检索管线

`createSearchEngine({ port })` 以固定顺序执行各阶段——plan 构建、各 lane 按注册表顺序串行、RRF 融合、加法 rerank、确定性 finalize——全部是 `RetrievalPort` 之上的纯逻辑，任何模块都不接触 fs、SQL 或时钟。数值常量逐字移植自 `packages/index/code-index-search/src/config.ts`：

- **Preselect** 折叠默认层（working-set/recent/pinned/overlay 排名衰减、FTS 摘要、逐 token 的符号/路径匹配、门控 fallback），并规范化 query、过滤条件与按分档钳制的 top-K。显式 `paths` 范围计 10.0 分。过滤 DSL 解析全部四个键——见 [The filter DSL and the literal lane](#the-filter-dsl-and-the-literal-lane)。
- **Lane**：`createLexicalLane`（bm25 排序的 FTS 匹配，候选上限 24）、`createGrepLane`（按新近度排序、扫描上限 20000 行、候选上限 12），以及 [Phase 3](#phase-3-dsl-literals-vectors-analysis-ops-and-heuristic-languages) 一节描述的 graph、literal、vector lane。新 lane 与 preselect 层经 `defineRetrievalLane` / `definePreselectLayer` 注册；组装期校验 id 唯一且至少一条启用 lane，从不在检索中途校验。
- **融合**：倒数排名融合 `k = 50`，lane 权重 lexical 1.1 / grep 0.8；融合总分截到 rerank 窗口 40 个候选。
- **Rerank** 对每个候选叠加一张有迹可循的加法表：query 重叠 ×0.35、doc 文件 +0.08、路径前缀 +0.05、working-set +0.22、recent 文件 +0.12、pinned 上下文 +0.20、overlay 邻居 +0.10，以及 `min(stage-a × 0.04, 0.25)` 作为 stage-a 保底。`symbol-exact` 加分（+0.18）随 `FeatureGates.symbolExactEnabled` 门控，如今默认开启，因为每个 semantic 档切片都带符号名。
- **Finalize** 按分数降序排序、chunk id 升序破平，受该分档的输出字符预算约束。

确定性是结构性的：固定阶段顺序、组装期注册表校验与快照稳定排序意味着同一请求在未变化的 epoch 对之下返回相同 hit。每个加分项都产出 `reasons` token，使每个 hit 自我解释；`truncated` 区分预算截断与排名耗尽。

## 存储布局

schema（[rlh-code-index-sqlite](../../packages/index/code-index-sqlite) 的 `src/ddl.ts`）保留 chunk 核心（`metadata` 为承载 epoch 对的键值账本；`files` / `chunks` 为 STRICT 行源，chunk 随其文件级联删除并携带 `chunk:<file>:<index>` 标识符）、三个 FTS5 镜像（`chunks_fts`、`files_fts`（`unicode61 remove_diacritics 2`）与 trigram 的 `file_paths_fts`），以及 [AST 解析与符号图](#ast-parsing-and-the-symbol-graph-phase-2) 一节描述的 v2 图表。应用侧维护先于删除经基表解析待删行的 rowid，并在插入时按基行自身的 rowid 重镜像；只有 `file_paths_fts` 仅凭触发器自愈。

准入 fail closed：外来的 `application_id`（或不存在于任何已注册 id 之下的用户表）以 `CODE_INDEX_DB_FOREIGN_APPLICATION` 原样拒收文件；已准入但版本越界或含未识别表的存储就地重建而不是迁移——这里的每张表都是可重建的派生数据。缺失的目录与文件以仅属主权限创建（`0700`/`0600`）。codec 注册 `'plain'` 与 `'zstd'`（以 base64 文本存储的 Zstandard level-3 帧，当压缩能把越过 128 字节阈值的 payload 缩小时选用）；未识别的存储标签、或解压失败的 `'zstd'` payload，都抛错而不是猜测，且 `chunks_fts` 镜像始终保存解码后的文本。解码后的 chunk 文本进入以 `(index_epoch, chunks.rowid)` 为键的 LRU 缓存，任何提交都使其自然失效，degraded 读结果永不进入。读取侧（`createRetrievalPort`）用裸 SQL 实现检索包的 port——bm25 排序、渲染为 WHERE 子句并转义 LIKE 元字符的 scope 过滤、逐行惰性解码的流式读取——扫描预算则留在检索侧。

## Provider 管线

[rlh-code-index-local](../../packages/index/code-index-local) 为单个工作区组装扫描、diff、切片与存储：

- **排除由静态层与分层规则组合**——15 条内建硬排除和显式配置 `exclude` 模式保持静态；每次 pass 发现根目录及嵌套 `.gitignore`，匹配规则按根到叶生效，因此更深层的否定规则可覆盖祖先规则。被排除目录在下降前剪枝，文件候选资格仍由固定的 27 条 include glob 表决定，symlink 永不扩展遍历。
- **Diff** 以 mtime+size 为快路径，对可疑候选重读一次做哈希确认，抑制 touch 误报与 mtime 抖动。
- **切片**把接受的文件切成至多 80 行的行窗（`generic` parser 档，置信度 0.5）；不可解码载荷按二进制跳过，超过 `maxFileBytes`（默认 512000）的文件只记录行、不产出 chunk，首窗文本支撑 `files.summary` / `content_excerpt`。
- **存储路径**默认 `<rlhHome>/index/code-index-<hash>.sqlite3`，其中 `<hash>` 是工作区真实路径 SHA-256 的前十二个十六进制字符；`$RLH_HOME` 或显式 `databasePath` 覆盖它。其余旋钮：`workspaceRoot`（进程 cwd）、`journalMode`（`wal`）、`debounceMs`（500）、`watcherEnabled`（`false`）。配置错误在加载时大声失败。

## AST parsing and the symbol graph (Phase 2)

[rlh-code-index-parser](../../packages/index/code-index-parser) 把一个被接受文件的文本转换成派生索引存储的抽取记录：symbol、import、调用边与字符串字面量。九个 web-tree-sitter 语法 WASM 覆盖十个语言名（`jsx` 用 JavaScript 语法解析）；它们每个进程加载一次，来自 `resources/grammars/`，每个产物的上游 release URL 与精确字节大小都钉在 `resources/grammars/VERSION` 中。产物采用 tree-sitter 官方 release 构建，因为 `tree-sitter-wasms` npm 包携带 web-tree-sitter ≥ 0.25 无法加载的旧式 `dylink.0` 段。walker 覆盖决定解析档：JS/TS 家族、Python 与 Rust 走 `semantic`（置信度 0.85），Go、Java 与 C/C++ 走 `tree-sitter`（0.7）。web-tree-sitter 不暴露解析中断钩子，因此没有超时 API——病态文件的代价只是一条 `parseErrors` 记录，绝不会卡死 pass。标识符是内容派生的 sha256 前缀（`uid:` 以文件加限定名键入，行漂移不改 id、签名变更则移动 id），这是对参考实现按位置派生 id 的刻意偏离。

### 解析绑定阶梯

未绑定的调用边对常驻进程内的 `SymbolCatalog`（从 `symbols` 表批量加载、按变更批次逐出）经固定的九步阶梯解析：`self_member → scope_binding → same_file → import → suffix → global_unique → fuzzy_arg_count → fuzzy_receiver → fuzzy_import_distance`。每个策略名都有默认置信度（exact 1.0、qualified 0.95、scope 0.9、import 0.85、global-unique 0.75、suffix 0.65、fuzzy-signal 0.55、heuristic 0.5、fuzzy 各档直至 0.3、unresolved 0），以 `resolution_kind` / `resolution_confidence` / `resolution_strategy` 存在边上；fuzzy 步使用解析器派生的调用点信号（参数个数、receiver 文本、import 距离），让调用点证据 outrank 纯名称接近度。

### 图存储

v2 图表——`symbols`、`imports`、`call_edges`、`symbol_refs`、`test_edges`、`literal_index` 与 `symbols_fts` trigram 镜像——与 chunk 核心共用同一批 delta 事务，一个批次的 symbol、边与指纹在单次 epoch 递增下原子提交。重绑定经阶梯把边绑定到目标的 `symbol_id` / `symbol_uid`；目标被删除或改名会把 importer 的边回滚到原始的 unresolved 状态。测试边只由路径派生（`same-basename` 0.9、`path-overlap` 0.7），且只在路径集合发生变化的增量 pass 重建——全量构建不写测试边，纯内容重写则保持已提交的边原样。

### 检索富化

搜索引擎在 lexical/grep lane 之后装配 graph lane（RRF 排名位置）与 graph-neighbor preselect 层，且每次 search 走 `searchWithGraphContext`：顶部 hit 解析到 symbol uid，一次度数/引用批量读计算连通度分 `min(ln(in+out+1)/10 + min(refs,10)/100, 0.4)`，被赋分的 hit 以 `score += graphScore × 0.3` 加成并追加 `boost:graph-rerank` 理由 token，然后执行唯一一次最终排序。答案为每个 hit 携带可选的 `graphScore`；以 epoch 对为键的结果缓存（32 条，degraded 结果永不入缓存）让重复查询不必重跑富化读取。

### The explore_code_graph tool

seam 上的 `exploreGraph` 在同一批表上回答三类问题，装配位于 provider 的 `src/explore.ts`：`relations` 沿某符号的 caller 和/或 callee 行走，深度 1–2（端口按 seed 侧读取，caller 因此经 `calleeRowsByUids` 读回）；`impact` 对符号或文件集做反向可达性扫描并附受影响测试对；`tests` 将代码文件映射到覆盖它们的测试对。每 seed 边窗口复用分档富化限额；请求的 `max` 对渲染节点做全局封顶（先 target，后边端点——第一次拒收即停止渲染并记录 `max_nodes`）；测试对按分档 `maxTests` 封顶（截断记 `result_limit`）。解析不到目标的请求返回空答案，并在 `explain.readErrors` 记一条 `symbol_not_found: <name>`——这是降级，不是截断；存储失败作为结构化工具错误向上传播，不做降级。

### 脏传播

增量 pass 为每个变更文件计算 sha256 导出指纹（其导出面），与写入前的值对比，并经 import 图重解析传递性 importer 闭包——每个 pass 受 `dirtyPropagationMaxFiles`（默认 200）与至多 `DIRTY_CLOSURE_MAX_ROUNDS` 轮约束，re-export 链折叠进闭包。reload 策略对每个被提升文件的边分类（unresolved seed 重跑完整阶梯，已绑定边先复核目标），改名导出会重绑定而不是积累陈旧行。

## Phase 3: DSL, literals, vectors, analysis ops, and heuristic languages

### The filter DSL and the literal lane

查询 DSL 解析四个键——`kind:` / `lang:` / `path:` / `name:`——键大小写不敏感，取值可用引号或裸词；未知的 `foo:` token 保持自由文本，空值被消费但不生效，重复键保留第一个值（对参考实现 last-write 行为的具名偏离）。`kind:` 经符号类别匹配器归一化，`lang:` 按解析器语言名过滤（未知名不过滤任何内容，与参考实现的 `Language::from_name` 一致），`name:` 以 +0.25 加分进入 rerank 并携带 `dsl-name:` 理由 token。

literal lane（权重 `search.literal_weight`，默认 0.9）对 `literal_fts` 镜像（schema v3）执行 bm25 排序的 FTS5 `MATCH`，并把每条命中行归属到其行距覆盖它的 chunk——融合管线只认 chunk 身份。JS/TS 字面量（含 SFC script 块）经一张按优先级排序的分类器映射到九类词汇（`route`、`url`、`topic`、`queue`、`env_key`、`config_key`、`sql`、`error_string`、`log_key`）；无法分类的字面量完全不落记录，Python 与 Rust 不产出字面量行。该 lane 依赖 port 的可选 `literalFtsCandidates` facet，缺失时自行禁用，因此未升级的 adapter 原样工作。

### The vector recall tier

Schema v8 以 `embedding_generations` 持久化完整 generation 身份，字段覆盖 provider、无凭据 endpoint、model、维度模式、归一化、量化器与 chunker。`chunks_vec` 为每个 `(chunk_id, generation_id)` 存一条 int8 量化嵌入；`code_embed_jobs` 按 `(chunk_id, generation_id, content_hash)` 幂等入队。不同 endpoint 即使模型同名也不会混用向量，job 和 vector 都随 chunk 或 generation 级联删除。当前内容的终态失败只获得一次持久化 `reconcile_resets` 重置，既修复暂态失败也避免无限重试。

量化是逐向量对称 int8：最大绝对分量映射到 127，保持 `[-127, 127]` 的对称范围。排序从不物化反量化向量——`cosineQuantized` 直接在 int8 字节上算 `cosine = (scale · Σ query[i]·q[i]) / (|query| · norm)`，其精度来自"精确小整数 × 浮点 query 分量"的累加；结果可能因量化误差略超 1，需要严格单位区间的调用方自行钳制。

嵌入队列按批量认领 → 批量读取 → 嵌入 → 量化 → 单次向量提交 → 逐 job 结算推进。每个成功向量批次恰好让 `embeddingEpoch` 前进一次，而 `indexEpoch` 与预留的运行时 `evidenceEpoch` 冻结；provider 聚合 usage 会确定性分摊且总数不变。租约、重试、截止时间和确定性失败仍沿原有尝试预算语义。 Client 实现在 [rlh-code-index-local](../../packages/index/code-index-local) 中。

provider 打开时及每次刷新提交后，generation coverage reconciler 都会计算当前 chunk 中缺少该 generation 向量的差集并入队，随后调度一次折叠 drain。因此后来启用 Embedding 或切换 endpoint/model/dimensions 会回填未变化 chunk。vector lane 只读取当前 generation；query embedding 与图结果缓存把查询向量和完整时钟快照入键，Embedding 批次会失效向量前答案而不会推进运行时证据。

### cycles and dead_code explores

`exploreGraph` 新增两个分析 op，都是在既有表上的纯答案装配。`cycles` 对文件 import 图跑迭代式 Tarjan SCC：只有规模 > 1 的分量算数（自 import 永不出现），分量在 `max` 截断前按规模降序排列因此截断保留最大环，严重度在成员 ≥ 5 时为 `high`、≥ 3 时为 `medium`，每个分量携带见证边——两端都是成员的已存 import 行。`dead_code` 经至多 `min(40 × cap, 5000)` 行的有界扫描找出无入向 caller 且无外部引用的符号：phase-1 过滤（空身份、`main` / `__init__` / `setup` / `configure` 等入口名、`test_*` / `Test*` 测试前缀）与 phase-2 外部引用消除；每个幸存者报告 `reason: 'no-callers'`，默认条目上限 50。两个 op 都投影自己的边——cycles 的见证边、dead-code 声明的 `CALLS` / `REFERENCES` 反向查找——工具的 `op` 枚举自此覆盖全部五类问题。

### Spec-driven languages and SFC extraction

分档矩阵覆盖二十个受支持语言名——十九种实际语言，`jsx` 共享 JavaScript 语法——分四档：JS/TS 家族、Python 与 Rust 为 `semantic`（0.85）；Go、Java 与 C/C++ 为 `tree-sitter`（0.7）；两个 SFC 名 `vue` / `svelte` 为 `heuristic` 并钉住 0.78（参考实现 `parse_sfc` 的置信度——对启发式默认 0.5 的具名偏离）；八个正则驱动语言——C#、PHP、Ruby、Swift、Kotlin、Dart、Scala、Lua——为 `heuristic` 0.5。spec-driven 抽取器移植参考实现 `spec_driven.rs` 的表（symbol、import、同文件调用边、调用关键词黑名单），完全不需要语法；其 C# `GetEnvironmentVariable` 数据流边与 resolution-tier 边字段不在本记录词汇内。SFC 抽取复用 JS/TS 语法处理每个组件的 `<script>` 块，因此组件解析不需要专属 wasm；`event_emitter` dispatch 类别为 SFC 模板事件边预留，目前没有 walker 发射它。

### The code-context recall contributor

[rlh-code-context](../../packages/context/code-context) 属于 `context` 组，不在索引接线之内，是 seam 的第一个上下文侧消费者：一个可选启用的 step-context contributor，把每个 step 的 direct user 文本拼成一个 query——同文本的多处 `@file` 提及作为显式 `paths` 范围随行——执行一次排序检索，再批量 hydrate 被选中的候选。健康答案贡献一条不可信的 `## Code-index recall` 消息，其中包含已对当前源文件验证的 fenced snippet（entry 预算按排名顺序施加：`maxChars` 65536、`maxHits` 8、`minQueryChars` 8），外加每条被接纳 snippet 一条证据记录；其 `revision` 是源文件内容哈希，digest 覆盖实际注入的源码。过期或不可用的 hydration 会被省略并写入警告与 coverage；无命中的 step 得到一条简短的有界否定消息，degraded search 或 hydration 全失败则除结构化警告外不贡献任何内容。反递归是结构性的：query 只读 direct user 消息，注入的 recall 文本绝不会成为下一次 query 的输入，`form: 'recall'` 的源记录也不进入 session-query 语料抽取。没有 config section 的 Loader 条目只构造 `ctx.codeContext`、不注册 contributor，且该包不进任何 bundle。

## 失效与刷新

三个触发入口折叠进同一唯一在途 pass：显式 `refresh()` 调用、工具结果失效器（去抖的全量 stale pass，默认 500 ms）、以及可选的递归 watcher；watcher 保留并合并原生事件路径进入 `RefreshOptions.paths`，`.gitignore` 事件则扩宽为全量 pass。每次查询还会惰性保证介质足够新鲜（`reason: 'lazy'`），而不是抛出 `CODE_INDEX_NOT_INDEXED`。watcher 只是延迟优化——正确性来自遍历本身——因此无法绑定时 provider 降级为 touch 驱动失效并经 `status().degraded` 报告；watcher 事件也可能滞后 pass 至多一个去抖窗口。摘要与 epoch 只在 pass 提交之后发布。 `BuildExplain` 记录全量/定域、执行/跳过、dirty closure/预算状态、降级原因、generation 回填、失败 job 重置，以及异步完成的 Embedding 批次/job 计数。无 delta 的 pass 跳过写事务且不推进 `indexEpoch`。

## 工具面

[rlh-tool-code-index](../../packages/index/tool-code-index) 是 function 插件，其四个工具把 snake_case 参数映射到 seam 请求（`path_prefix` → `pathPrefix`、`recent_paths` → `recentPaths`、`top_k` → `topK`；`explore_code_graph` 把 `file_path` / `include_tests` 映射到图探索联合）；`include_grep: false` 转发一个 provider 可忽略的 grep lane 建议性提示。explore 工具跨 op 的非法组合（如 `op=tests` 缺 `files`）是在 `execute` 里抛出的普通参数错误。`code_index_status` 无参数；`refresh_code_index` 接受 `force?` 从零重建。当一个 tool 驱动的刷新 pass 仍在等待时，第二个立即以 `INDEX_TOOL_REFRESH_IN_PROGRESS` 应答而不是排在折叠之后排队；provider 抛出的无稳定码错误变为 `INDEX_TOOL_FAILED` 并把原始错误附为 `cause`，provider 的稳定码（如 `CODE_INDEX_NOT_INDEXED`）原样传播。

输出预算施加在唯一出口边界上，移植自参考 `ExitPolicy` 设计：`search_code_index` 对完整序列化答案做字节上限，status 与 refresh 是 passthrough，因为它们的形态天然有界。上限在执行完成后读取答案自身携带的分档（`repoSizeTierMaxOutputChars`：18000/24000/32000/38000）并按 UTF-8 字节计量；256 字节预留保证信封自身的键留在原预算之内。超预算响应返回截断信封 `{ _truncated, _original_chars, _max_chars, partial }` 作为规范值，渲染为恢复性文字，绝不把 `partial` 展开回上下文。`clampTopKToTier: true` 时模型可见的 `top_k` 旋钮从 schema 消失，命中数始终由引擎的分档钳制决定。

插件随附一个固定 system-prompt section（`tool:code-index`，order 107，位于文件系统发现与 shell 工具之间），告诉模型在符号/切片问题上优先用索引，符号已知后用 `explore_code_graph` 处理跨文件结构问题（caller/callee 行走、带受影响测试的影响面扫描、文件到测试的映射），grep/glob 留给精确字面量与穷举出现位置，并在归咎索引漏报之前先用 `code_index_status` / `refresh_code_index` 核对 epoch。

## Model 可见行为

hit 每条渲染为一行 `path:start-end score reasons`，位于分档标注的表头之下；`readErrors` 非空时出现 `[degraded]` 说明；恰在引擎截断排名时出现候选计数页脚。explore 答案同样渲染：分档标注的 op 表头、每 node 一行 `role kind name @ file:start`、每边一行 enrich 模板 `caller: X → Y (f:line)`、每测试对一行 `test: spec → code (reason)`，以及仅在截断发生时出现的 explain 摘要尾标。结果在未变化的 epoch 对之下确定，经 `reasons` token 自我解释，并受双重约束——引擎 top-K 使命中数保持很小，出口上限约束完整答案。四个工具在 KV-cache 层面都是追加型：工具结果跟随可复用请求前缀，绝不使既有条目失效。


### 检索评测门禁

`evaluateRetrieval` 经公开 seam 执行判断。检入的 TypeScript、Python、Go fixture 仓库，加上当前 package 与定域增量样本，形成 Recall@5、MRR、增量 p95 的可执行阈值。更广的外部仓库相关性 corpus 可沿同一格式扩展。

## 已知限制

- **图探索止于深度 2**——`relations` 接受 `depth` 1–2；更深遍历等有消费者需求再做。
- **没有解析超时 API**——web-tree-sitter 不暴露中断钩子，病态文件依赖逐文件隔离与容错遍历，而非时间上限。
- **启发式档就是正则启发**——八个 spec-driven 语言与 SFC `<script>` 复用带着参考实现的黑名单与置信度钉值，但没有语法；其 C# `GetEnvironmentVariable` 数据流边与 resolution-tier 边字段（callee uid、resolution kind/strategy）不在本记录词汇内，预留的 `event_emitter` dispatch 类别也尚无 walker 发射。
- **字面量索引只有 JS/TS 分类**——九类分类器决定哪些字面量值得落记录，Python 与 Rust 不产出字面量行，分类器的 config-key `key_path` 也仍未进入存储记录面。
- **环分析只有文件粒度**——参考实现的 package/community 投影（及其 `critical` 严重度档）留在那里；分量按规模降序，严重度止于 `high`。
- **嵌入成本治理只有 drain 粒度**——预算是 `maxJobsPerDrain` / `maxPromptTokensPerDrain` 加逐 job 的 `usage_json`；没有跨运行或墙钟时间的花费上限，需要者必须在 provider 之上自行持有。
- **待处理嵌入 job 等待 drain 触发**——队列是持久的，但 drain 只在折叠进一次已提交刷新时启动；进程在 drain 前退出，job 就保持 pending 直到下一次刷新 pass。
- **code-index 层不在 Python 发行版内**——没有已发行的 agent preset 挂载 `rlh-tool-code-index*` 插件，`python/sdk-runtime/package.json` 也无对应依赖，因此 `verify-runtime-closure` 正确地不要求它；要在部署根发行该层，preset 行与完整的七包运行时依赖链必须同时补上。
- **存储为同步**——`DatabaseSync` 在每条语句期间阻塞 JavaScript 线程；不匹配的存储就地重建，不提示地丢弃已确认状态。`'zstd'` 编码把压缩帧存成 base64 TEXT，因此对刚好越过阈值、压缩收益有限的 payload，存储形态可能反而大于明文。
- **索引广度与并发都有界**——include/hard-exclude 表保持固定，嵌套 `.gitignore` 生效；stat/hash/read-parse 阶段使用确定性的 16/8/4 并发。不安全 watcher 事件仍扩宽为全树。
- **watcher 不是正确性来源**——它只优化延迟，按设计静默降级为 touch 驱动失效，其事件可能滞后 pass 至多一个去抖窗口。
- **一个 local runtime/store 按构造只服务一个 Workspace**——Web 将 Session cwd 交给 Workspace router，绝不在规范根目录之间共享 runtime 或数据库。显式单 Workspace adapter 会拒绝不匹配的根目录；只有操作方绕开 router 并刻意复用同一 `databasePath` 才能破坏此边界。
- **刷新忙守卫是进程内的**——部署应只挂载一个工具 Consumer。
- **`RefreshSummary` 只携带聚合计数**，这是设计选择，为的是每个出口都有界。
- **compaction checkpoint 可能把 recall 衍生文本重新索引进语料**——checkpoint 以带 plugin source 的 `user/message` 落入日志，session-query 语料抽取（只跳过 `form: 'recall'` 消息）会像索引 assistant 回复一样索引其摘要，而摘要可能复述 recall 衍生文本。ADR 0006 第 6 条反递归边界止于系统注入上下文；模型创作的 checkpoint 摘要位于 assistant 回复一侧。
- **`dead_code` 不使用 `files.is_test_file` 列**——测试文件排除只按名称前缀（`test_*` / `Test*`）进行，工具接受的 `max` 上限为 10000，扫描上限为 `min(40 × max, 5000)` 行；两处细节均逐字照抄参考实现。


### Code Index Center 产品界面

`managementStatus()` 投影文件/chunk 数、epoch、BuildExplain、Embedding generation、coverage、积压、失败 job 与有界错误。Typed Host Remote 暴露 refresh、reconcile、确认门控 rebuild 和紧凑 search debug（500 查询字符、20 路径、top-K 20；不 hydration）。Web Settings 渲染这些事实并要求输入 `REBUILD`；Host 独立校验 token。默认 Web composition 包含 workspace router 和 code-context contributor，Desktop 复用同一 Web UI。每个 Remote 请求携带 `sessionId`；Host 解析已附着 Session 的 cwd 并绑定对应独立索引。Client cache 按 Session 分区并跟随 Session 切换。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcodecontext--codecontext"></a>

### `ctx.codeContext` — `CodeContext`

Owner of the code-index recall contributor (`ctx.codeContext`). The service itself carries no query surface: it exists so a deployment can observe that recall injection is active and dispose it as one unit. Registration is strictly opt-in — a Loader entry without a `config` section constructs the service but registers no contributor.

Source: [`packages/context/code-context/src/index.ts:52`](../../packages/context/code-context/src/index.ts)

<a id="ctxcodeindex--codeindex-abstract-seam"></a>

### `ctx.codeIndex` — `CodeIndex` (abstract seam)

Service Definition for the local code-index capability (`ctx.codeIndex`).

```ts cordis-catalog
/**
 * Report index health without side effects.
 * @returns current file count, resolved tier, epoch pair, last refresh summary, and degraded flag.
 */
abstract status(): Promise<IndexStatusReport>

/**
 * Operator-oriented health projection; providers may enrich the basic status.
 * @returns bounded file/chunk/generation/build health for management clients.
 */
async managementStatus(): Promise<import('./types.ts').CodeIndexManagementStatus>

/**
 * Reconcile provider-derived work without requiring a destructive rebuild.
 * @returns settled management status after reconciliation.
 */
async reconcile(): Promise<import('./types.ts').CodeIndexManagementStatus>

/**
 * Bring the derived index up to date with the workspace tree (or rebuild it).
 * Concurrent calls fold into the single in-flight pass; refresh summaries are emitted only
 * after that pass commits, never speculatively.
 * @param options - trigger reason, forced full rebuild, or explicit path subset.
 * @returns what changed and the epoch pair after the final commit.
 */
abstract refresh(options?: RefreshOptions): Promise<RefreshSummary>

/**
 * Run deterministic hybrid retrieval over the indexed chunks.
 * @param request - query plus optional scope, recency, prefix filter, and requested size.
 * @param signal - cancellation for the active step.
 * @returns ranked hits with epoch pairing; `degraded=true` when a lane failed partially.
 */
abstract search(request: SearchRequest, signal?: AbortSignal): Promise<SearchResult>

/**
 * Resolve full indexed source bodies for an ordered batch of chunk identities.
 * Providers revalidate each backing source against its indexed content hash;
 * stale or unavailable identities are returned only in `rejected`.
 * @param request - ordered chunk identities to hydrate.
 * @param signal - cancellation checked before and after the synchronous store read.
 * @returns resolved bodies, explicit misses, and the generation observed by the read.
 */
abstract hydrateChunks(request: HydrateChunksRequest, signal?: AbortSignal): Promise<HydrateChunksResult>

/**
 * Answer one structured graph question over the derived call graph.
 * @param request - the `relations` / `impact` / `tests` / `cycles` / `dead_code` question
 *   with its per-op options.
 * @param signal - cancellation for the active step.
 * @returns nodes, edges, optional test pairs, cycle components, or dead-code candidates,
 *   plus the explain envelope under the epoch pair they were read at; every rendered
 *   edge's endpoints resolve inside the answer's `nodes`.
 */
abstract exploreGraph(request: GraphExploreRequest, signal?: AbortSignal): Promise<GraphExploreResult>

/**
 * Bind this capability to one caller-owned workspace root. Multi-workspace
 * providers override this method and route every operation to an isolated
 * derived store. The default adapter preserves existing single-workspace
 * providers and test doubles; production filesystem providers should
 * override it to verify that `workspaceRoot` is their configured root.
 * @param workspaceRoot - absolute workspace root selected by the caller's durable Session.
 * @returns a workspace-bound operation face which cannot be retargeted after construction.
 */
forWorkspace(workspaceRoot: string): Promise<CodeIndexWorkspace>
```

Source: [`packages/index/code-index/src/index.ts:49`](../../packages/index/code-index/src/index.ts)
<!-- END GENERATED cordis-surface -->
