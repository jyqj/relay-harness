# Agent Note：完成本地 Vector Recall 与构建质量门禁

状态：已实现

[English](2026-08-29-code-index-vector-recall-build-explain-gates.md) | 中文

## 问题

Generation-keyed vector 与批处理修复了生命周期正确性，但 vector lane 仍只重打分 lexical、grep、graph 或 literal 已发现的候选。纯语义邻居无法进入 fusion。刷新摘要只暴露计数，不能解释 pass 为什么执行/跳过、dirty closure 降级、回填工作或已完成 Embedding 批次。Scanner、hash、parser 循环确定但串行。首版 eval harness 有指标却没有多语言可执行阈值，终态 Embedding 失败也可能成为永久覆盖洞。

## 决策

`VectorReadFacet.recallCandidates` 是 provider-neutral 最近邻 seam。SQLite adapter 实现 generation/scope 过滤、受 `vectorMaxCandidates` 约束的精确余弦扫描，返回 best-first hit 及 scanned/truncated 覆盖。未来 ANN 替换该方法而无需改 lane。Vector lane 把独立召回 hit 与前序 lane 候选的余弦分数合并，按最大相似度去重，再进入普通 RRF。因此纯语义 hit 携带与其它向量贡献相同的 `vector@rank` reason 和 `rrf:vector` score trace。

每次刷新现在都携带 `BuildExplain`：全量/定域、请求路径数、执行/跳过、降级原因、dirty 状态/标记数/轮次/预算，以及 generation 回填、重置、批次和 job 计数。无 delta 的刷新不打开写事务，也不推进 `indexEpoch`。分离的 Embedding 完成会更新 status 侧 last refresh，并持久化最终时钟与计数。

构建 I/O 使用确定性有界并发：每目录 stat/symlink 16 槽、可疑哈希 8 槽、变更文件读取/解析 4 槽。`mapConcurrentOrdered` 无论完成顺序如何都保持输入顺序，并让整个阶段大声失败。量化继续内联：可执行典型批次门禁测量 16 向量 × 1536 维，要求 p95 低于 25 ms；本机测得低于 0.5 ms，此时 worker 序列化/交接会增加而非消除压力。

Eval 门禁现覆盖检入的 TypeScript、Python、Go fixture 仓库、当前 local-index package、确定性相关性 case 和定域单文件增量样本。`assertRetrievalThresholds` 在 Recall@5、MRR 或增量 p95 回归时失败。Schema v8 新增 `reconcile_resets`；当前内容的终态失败只获得一次持久化重置，再次终态后保持失败，同时避免永久首次失败洞与无限重试循环。

## 考虑过的替代方案

- **RRF 之后注入语义 hit**——否决；它会绕过正常 reason、score trace、rerank、filter 与输出预算。
- **把精确余弦 SQL 写进 lane**——否决；这会把 domain engine 绑定 SQLite，且没有 ANN adapter seam。
- **构建阶段使用无限 `Promise.all`**——否决；大仓库会以 descriptor/内存尖峰和不可预测压力换延迟。
- **始终把量化移到 worker**——被测量否决；worker 交接大于当前典型批次成本。
- **每次 reconcile 都重置失败 job**——否决；错误凭据会造成无限重试/花费循环。

## 后果

纯语义 recall 已真实存在，但精确扫描覆盖有意设界；`VectorRecallResult.truncated` 让 adapter/测试可观察该边界。ANN 是优化而非语义重做。BuildExplain 是有界 status/refresh 投影和工具输出 schema，不是无界逐文件 trace。并行阶段保持提交顺序及源码 hydration 语义。检入的多语言 corpus 可执行、可扩展；加入更广外部相关性判断可以提升代表性，而无需改变门禁协议。
