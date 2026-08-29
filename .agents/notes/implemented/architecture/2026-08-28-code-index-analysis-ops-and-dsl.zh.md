# Agent Note: Code-index filter DSL, classified literal lane, and the cycles/dead_code analysis ops

Status: implemented

[English](2026-08-28-code-index-analysis-ops-and-dsl.md) | 中文

## Problem

Phase 2 之后，检索面有三处参考实现早已补上的缺口。查询 DSL 只解析 `path:`——`kind:` / `lang:` / `name:` 落回自由文本——模型无法按符号类别或语言提问。`literal_index` 表只存逐字字符串且没有检索面：没有 FTS 镜像、没有 lane，排名管线没有任何可消费的东西。而 `exploreGraph` 只回答结构类问题（`relations` / `impact` / `tests`），循环依赖与死代码问题——参考实现的 `graph_cycles.rs` 与死代码读模型——无法移植，因为 provider 没有承载它们的 op。

## Decision

在检索与 provider 层一次性闭合三个缺口，seam 的请求/结果词汇仍是唯一的跨包契约：

- **过滤 DSL**（`code-index-search/src/plan.ts`，`parseDslLite`）。四个键——`kind:` / `lang:` / `path:` / `name:`——键大小写不敏感，取值可用引号或裸词。未知的 `foo:` token 保持自由文本；空值被消费但不生效；重复键保留第一个值，这是对参考实现 last-write 行为的具名偏离，为的是与此处既定的 `path:` 行为保持一致。`kind:` 经参考实现的符号类别匹配器归一化，`lang:` 按解析器语言名过滤，`name:` 以 +0.25 加分进入 rerank 并携带 `dsl-name:` 理由 token。
- **literal lane 与 schema v3**（`code-index-sqlite/src/ddl.ts`、`code-index-search/src/lanes.literal.ts`、`code-index-parser/src/languages/jsts/literal-classify.ts`）。Schema v3 为 `literal` / `literal_kind` 增加 `literal_fts` 镜像——与 `symbols_fts` 同款触发器自愈，可空镜像列 coalesce 成 `''` 因为 FTS5 拒绝 NULL。该 lane（权重 `search.literal_weight`，默认 0.9）执行 bm25 排序的 FTS5 `MATCH`，并把每条命中行归属到其行距覆盖它的 chunk（`chunkOwningLine`：最后一个起始于该行之前或当行的 span——span 之间可能留缝隙，较早的 chunk 是诚实所有者）。JS/TS 字面量经一张按优先级排序的分类器映射到九类词汇（`route`、`url`、`topic`、`queue`、`env_key`、`config_key`、`sql`、`error_string`、`log_key`，置信度 `0.92 × 0.85 = 0.782`）；无法分类的字面量完全不落记录，与参考实现同一道闸，Python/Rust 则停止产出逐字字面量行。该 lane 依赖 port 的可选 `literalFtsCandidates` facet，缺失时自行禁用，未升级的 adapter 原样工作。
- **cycles op**（`code-index-local/src/cycles.ts`）。对文件 import 图跑迭代式 Tarjan SCC：只有规模 > 1 的分量算数（自 import 是规模 1 的 SCC，永不出现），分量在 `max` 截断前按规模降序排列，截断因此总是保留最大的环，等规模按排序后的成员列表破平保持确定性；严重度沿用参考实现的文件粒度档（`>= 5` high、`>= 3` medium、否则 low），每个分量携带见证边——两端都是成员的已存 import 行。
- **dead_code op**（`code-index-local/src/dead-code.ts`）。无入向 caller 且无外部引用的符号，经至多 `min(40 × cap, 5000)` 行的有界扫描找出（参考实现的自适应扫描预算），phase-1 过滤（空身份、入口名 `main` / `__init__` / `__main__` / `setup` / `configure`、`test_*` / `Test*` 测试前缀）与 phase-2 外部引用消除。每个幸存者报告 `reason: 'no-callers'`；默认条目上限 50，op 声明其 `CALLS` / `REFERENCES` 反向查找。
- **边投影补齐。** 每个 op 的 explain envelope 现在声明它兑现的边类别；cycles 投影见证边，`relations` / `impact` 的行走边渲染不变，因此每个新答案保持"每条边的两端都解析进 `nodes`"的性质。工具的 `op` 枚举扩到五个值，`max` 语义按 op 区分（渲染节点、测试对、环分量、死代码条目）。

## Consequences

Schema 版本仅因字面量镜像从 2 前进到 3；图层的写面（delta 事务、`writeResolvedEdges`、测试边重建）原封未动。字面量覆盖是刻意收窄的：一个只覆盖 JS/TS 的分类 lane 优于一个塞满分类器本来就会拒收行的全语言逐字索引。环分析只有文件粒度——参考实现的 package/community 投影及其 `critical` 严重度档留在那里。同一 Phase 落地的还有向量层 schema 工作（[向量核心](../feature/2026-08-28-code-index-vector-core.md)）与启发式语言扩面（[启发式语言与上下文 contributor](../feature/2026-08-28-code-index-heuristic-languages-and-context-contributor.md)）；它们共同写入的五阶段增量管线归[脏传播 note](2026-08-28-dirty-propagation-five-stage-pipeline.md) 所有，工具面映射归[工具 note](2026-08-27-code-index-tools.md) 所有。

## Alternatives considered

- **跟随参考实现的重复键 last-write**——否决：此处既定的 `path:` 行为已是 first-match-wins；按键分化会让同一个 DSL 有两种行为，让混用过滤条件的每个调用方意外。
- **记录全部字面量、把类别当标签附上**——否决：参考实现用分类 gate 记录，因为不可分类的字面量没有检索价值；照存会让 `literal_index` 与 `literal_fts` 膨胀出没有任何 lane 能有意义排序的行，而后续扩类不需要 schema 变更就能重新收录。
- **连同 package/community 环投影一起移植**——否决：那些投影需要本 provider 不计算的模块聚类，其 `critical` 严重度档属于那个粒度；先交付文件级环分析，将来有消费者时零成本。
- **用图可达性（SCC 或反向 BFS）计算 dead_code 而非有界扫描**——否决：参考实现的扫描加过滤管线把读取上界钉在 `min(40 × cap, 5000)` 行、无传递遍历，使 op 成本与请求的 cap 成比例；可达性扫描会把答案成本耦合到请求无法约束的图直径上。
