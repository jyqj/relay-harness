# Agent Note：代码索引向量 lane 全链接——embedding 队列、记忆化查询向量与 RRF 融合的语义召回

Status: implemented

[English](2026-08-28-code-index-vector-lane-full-link.md) | 中文

## 问题

R4 片段交付了向量层的各个部件——`chunks_vec` 表、`code_embed_jobs` 队列、量化数学、embeddings 客户端与排干器——但没有任何东西把它们接进检索：没有面向向量的存储读取面，没有消费向量的 lane，没有把已提交 pass 关联到队列的入队触发器，也没有能覆盖"答案依赖查询嵌入"这一新事实的缓存键方案。缺了这些链接，这一层就是死重；随手接线另有风险，首当其冲的是图结果缓存——向量落地后 evidence clock 前进，对它视而不见的缓存键会一直端出向量落地前的陈旧答案——以及粘性的 `status().degraded`：一次瞬时的嵌入器故障就会把它永久置位。

## 决策

跨四个包闭合链路，seam 一律不动：

- **向量读取面**（`code-index-search/src/port.ts`，实现在 `code-index-sqlite/src/reader.ts`）。可选的 `RetrievalPort.vector` facet——与 literal FTS 镜像同一先例——暴露 `vectorsByChunkIds(chunkIds, model)`（字节一致的 int8 行及其标量）与 `vectorCoverage(model)`。没有向量层的端口仍是合法端口；未配置 embedding 的部署根本不会装配消费它的 lane。
- **向量 lane**（`code-index-search/src/lanes.vector.ts`）。该 lane 不自行发起候选查询：引擎的 lane 循环现在累积 `LaneContext.priorCandidates`（按注册序、去重、按新增的 `search.vector_max_candidates` = 2000 截断）交给后续 lane，vector lane 在池上用 `cosineQuantized` 对照 `EngineSearchRequest.queryVector` 重打分，丢弃非正相似度，至多上报 `search.vector_top_k` 条。它注册在最后（lexical → grep → graph → literal → vector，顺序仍由 search 包的 `defaultRetrievalLanes` 独有），缺 facet 或缺查询向量时自禁用；存量向量维度与查询向量矛盾会让整个 lane 中止进入 `readErrors`，而不是给噪声排名。
- **提供方装配**（`code-index-local`）。Config 增加可选 `embedding` 段（schemastery，credential-ref `apiKeyEnv` 默认 `EMBEDDING_API_KEY`）；缺 `baseURL` 或 `model` 即整体移除该层——无 lane、无排干、无向量状态。每次 refresh 提交后，提供方把本批 chunk 行入队（`chunkRevisionsForFiles` 将 chunk id 联接其文件内容哈希）并启动一个自身单飞的排干，与 refresh 调用方解耦。检索时把裁剪后的查询文本经 32 条 LRU（键为 `model:dimensions:text-hash`）嵌入，随引擎请求传入。查询嵌入失败只降级该次答案（追加 `readError`，不伪造向量贡献）；粘性降级收窄到整 lane 中止（`<laneId> lane failed`），失效的端点不再能永久置位 `status().degraded`。排干/入队失败绝不使已提交的 refresh 失败，而是经运行时内部的 `vectorStatus()` 投影呈现，seam 报告保持不动。
- **缓存正确性**（`code-index-graph/src/lane/engine.ts`）。`graphCacheKey` 本就携带完整 epoch 对——这是承重事实，因为 `writeChunkVectors` 每个任务恰好推进一次 `evidenceEpoch`——现在再用 `fingerprintVector` 给查询向量入指纹：字节一致的嵌入命中，同一查询文本的不同嵌入必失配。端到端测试钉住真正要紧的性质：排干推进 evidence clock 后，重复检索会重算（答案携带新 epoch），而不是端出排干前的缓存结果。

## 结果

落地内容：针对 fake embeddings 端点与真实 `:memory:` 库，端到端验证了入队 → 排干 → `chunks_vec` → 查询嵌入 → lane 重打分；未配置该层时零漂移（注册了 vector lane 但门控关闭时逐字节不变）；对不可达端点与空白凭据做诚实降级且不污染粘性标志；通过一次真实的维度矛盾 lane 中止演示粘性置位；四个涉及包逐文件覆盖率 100%。查询向量 LRU 刻意以文本哈希为键而非 `fingerprintVector`（后者需要向量本身作输入）：`fingerprintVector` 是缓存键工具，LRU 键是记忆化查找工具。向量 lane 未做超出排干器逐任务管线（每任务一次证据 epoch 提交）的批处理优化：N 次提交 N 次前进已被测试与 README 钉住，在没有消费者提出吞吐诉求前，不拿这份可审计性换性能。

## 备选方案

- **常驻向量 lane 加可用性探测**——否决：靠探测 `chunks_vec` 行数决定启停的 lane 会把每次冷检索变成隐式探测；能力探测式门控（facet 存在 + 请求携带查询向量）让未配置部署按构造零漂移。
- **把查询嵌入失败计入 `status().degraded`**——否决：粘性标志的职责是记录超越单次操作的存储侧状态；不可达的嵌入器是瞬时的，答案的 `readErrors` 已自明，置位后也没有消费者能对其采取行动的恢复信号。
- **模型标识放到 `EngineSearchRequest` 上**——否决：模型是提供方构造 lane（`createVectorLane({ model })`）时即固定的部署状态，不是逐检索的输入；放上请求会诱使同一引擎内混用不同模型的向量与行。
