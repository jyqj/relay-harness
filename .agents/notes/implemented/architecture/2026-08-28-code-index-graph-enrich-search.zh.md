# Agent Note: 图富化与图感知检索路径

Status: implemented

[English](2026-08-28-code-index-graph-enrich-search.md) | 中文

## 问题

检索管线停在融合一步：graph lane 只喂 RRF 排名位置，没有任何阶段把已存储的调用图变成逐 hit 分数或上下文节点；local provider 仍装配普通引擎默认，seam 的 `SearchHit` 也没有承载图贡献的字段。尽管度数、邻接、测试边都已通过检索端口落在存储里，生产检索依旧没有任何图 rerank。

## 决策

参考实现的图感知检索路径逐字落在 graph 包的 `src/lane/`，local provider 切换到该路径。

- **`graphEnrich` 逐段移植 `cc-search/src/enrich.rs`**——在解析窗口内批量解析符号（`maxResolve` 个 hit、去重文件路径、名字相等或行区间包含、uid 全局去重）、一次度数/引用批量读取、分数公式 `min(ln(in+out+1)/10 + min(refs,10)/100, 0.4)`，以及分档图 token 预算内的 caller/callee/test 节点收集。`GRAPH_SCORE_CAP` 保持为 graph 包常量，因为参考实现把封顶写成 enrich 侧字面量；rerank 权重归 `RankingConfig`（`graphRerankWeight`，默认 0.3），与参考实现的归属一致。
- **预算触界截断节段；去重先于预算判断。** break 直接放弃 caller/callee/test 节段剩余候选（参考实现的 `break`），被截断迭代消耗过的邻居 uid 保持已见标记——两者都是节点集合精确对齐的关键。
- **端口按种子侧命名边方向，参考实现按邻居侧命名。** 解析符号的 caller 因此经 `calleeRowsByUids` 读取（该符号作为 callee 的行）；explain 信封保留参考实现的 op 词汇（`caller_rows_by_uids`），读失败字符串保持可比。
- **端口形状的补偿，均在使用点注明：** 边投影不携带存储置信度，节点置信度改由 resolution kind 经解析器的默认置信度表推导（缺失记 0）；`findImpactedTests` 返回原始关联行，测试路径在内存去重，而参考实现由 SQL `DISTINCT` 完成。
- **`searchWithGraphContext` 是图贡献的唯一落点**——为每个命中加成（`score += graphScore · graphRerankWeight`，reason `boost:graph-rerank` 追加在尾部）、唯一一次最终排序（分数降序、chunkId 升序）、rank 重排，再按 top-K 截断（缺省取分档默认，`0` 映射为 10）。零分照常赋 `graphScore` 但不加成、不加 reason，对应参考实现的零额 traced boost。
- **结果缓存键覆盖双 epoch、请求哈希（列表与顺序无关）、全部富化限额、token 预算与 ranking 指纹**（resolved `RankingConfig` 的稳定 JSON）。引擎自身 search 配置刻意缺席：缓存实例属于一个绑定的引擎，provider 在分档重组重建检索栈时一并丢弃缓存。降级结果（`readErrors` 非空）照常返回但绝不入缓，瞬时读失败会被重试而不是钉死在 epoch 对上。容量默认 32，即参考实现的 `GRAPH_RESULT_CACHE_CAPACITY`（不移植其环境变量旋钮）。
- **provider 永远走图路径**——空图时富化解析不到符号，答案与普通管线一致（组合默认装配套件已按字节证明），因此不存在可用性探测。seam 增加可选 `graphScore` 字段与 `repoSizeTierTokenBudget` 表（4000/6000/8000/12000）；search 工具的严格输出 schema 同步认识这个新的可选 hit 字段——这是本刀允许包之外唯一的编辑，由本刀拥有的 seam 扩展强制产生。

## 已考虑的替代方案

- **像参考实现那样在截断前富化整个 rerank 窗口**——本阶段否决：本仓的入口是已最终化的 `engine.search(request)`，其 hit 已按 top-K 截断。分档表保证 `maxResolve`（3–8）低于每档 top-K（5–20），解析范围一致；加成无法救回已被基础截断丢弃的 hit，provider 级一致性套件钉住了这一点。
- **让 `createSearchEngine` 的返回暴露 resolved ranking**——否决：为单个调用方加宽 search 包表面不值；`searchWithGraphContext` 改为自行逐字解析 `ranking` 入参，provider 不传即与默认一致。
- **把限额截断（`maxResolve`/`maxTests`）标记为 truncated**——否决：参考实现的信封在仅触及静态限额的普通运行里保持为空；只有预算截断（消费者原本永远看不到的真实裁剪）记录 `output_budget`。

## 后果

本地答案现在会把图连通的 chunk 排到其基础分之上，并把图侧降级经 `degraded`/`readErrors` 上报。富化节点视图仍是包内中间形态；把它投影为模型可见表面是下一阶段的事，届时也要处理 `searchWithGraphContext` 目前保持 `SearchResult` 形状的 seam 缺口（节点在答案之侧，而非之内）。
