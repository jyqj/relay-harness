# @relay-harness/rlh-code-index

[English](README.md) | 中文

**`CodeIndex`**（`ctx.codeIndex`）定义本地代码索引后端的 WHAT——报告健康状态、刷新当前工作区的派生磁盘索引、对已索引 chunk 做确定性混合检索——而不规定它如何存储、扫描或排序。

本包是 code-index 能力三角之一，按职责拆分使各关注点独立演进（和替换）：

| 包 | 角色 |
|---|---|
| `@relay-harness/rlh-code-index`（本包） | Service Definition：抽象服务 + 词汇类型 + 仓库规模分档 |
| `@relay-harness/rlh-code-index-local` | Service Provider：工作区扫描、增量 diff、通用切片器、SQLite 索引 |
| `@relay-harness/rlh-tool-code-index` | Consumer：模型可见的 `search_code_index` / `code_index_status` / `refresh_code_index` 工具 |

## 服务 API（`ctx.codeIndex`）

| 成员 | 语义 |
|---|---|
| `status()` | 只读健康报告：已索引文件数、解析出的 `RepoSizeTier`、epoch 对、最近一次刷新摘要、degraded 标志。无副作用。 |
| `refresh(options?)` | 使派生索引与工作区文件树保持一致，或强制全量重建。并发调用折叠为唯一在途扫描；摘要只在该扫描提交之后发布。 |
| `search(request, signal?)` | 对已索引 chunk 做确定性混合检索。结果携带读取时的 epoch 对与 `degraded` 标志；消费方必须将任何 `readErrors` 非空的结果视为不可缓存。 |
| `exploreGraph(request, signal?)` | 在派生调用图上回答一个结构化图问题（`relations` / `impact` / `tests` / `cycles` / `dead_code`）。答案携带 nodes、edges、可选 test pairs、环组件、dead-code 候选与 explain 信封，并绑定读取时的 epoch 对；每条渲染边的两端都可解析到答案的 `nodes` 内。 |

## 词汇表

`EpochPair` 是两个单调时钟：`indexEpoch` 在每个承载内容变更的写事务提交时恰好前进一次；`evidenceEpoch` 预留给语义证据摄入。seam 之上的所有缓存键必须同时包含两个值——epoch 过期的缓存条目即使字节完全相同也是过期。`RepoSizeTier`（`tiny` / `small` / `medium` / `large`，以 500 / 5000 / 25000 文件数边界划分）是自适应常量的唯一来源（`src/tiers.ts`）：搜索 top-K 上限、输出字符预算、snippet 预算、token 预算与图富化限额都是分档的函数，与调用点无关。`SearchResult` 有界且自描述：hit 按确定性顺序排名（分数降序、chunk id 升序破平），每个 hit 通过 `reasons` token 自我解释，`truncated` 区分预算截断与排名耗尽，可选的 `graphScore` 携带图富化赋予的连通度分（无图上下文时缺省）。图探索词汇（`GraphExploreRequest` / `GraphExploreResult` 及其 node/edge/test/cycle/dead-code/explain 视图）命名了 provider 将在派生图上回答的关联、影响、测试、环与死代码问题，并受分档图富化限额与各 op 自身上限约束。完整契约见 `src/types.ts`。

## Model Experience

间接地，通过 `@relay-harness/rlh-tool-code-index` 提供的 `search_code_index`、`explore_code_graph`、`code_index_status` 与 `refresh_code_index` 工具。

#### KV Cache 效果

不直接改变请求前缀；检索输出如何进入对话由各消费方负责。

## 已知限制与延后工作

- **seam 携带已有消费者的分档常量**——搜索上限、输出/snippet 与 token 预算、图富化限额；每张表都有检索路径上的消费阶段。
- **`evidenceEpoch` 是只读占位**，直到语义证据摄入提供写入方。
- **`RefreshSummary` 刻意不暴露逐路径明细**——只有聚合计数，保证每个出口有界。
