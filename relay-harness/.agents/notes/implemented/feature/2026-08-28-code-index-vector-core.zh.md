# Agent Note: Code-index vector core — int8-quantized chunks_vec, the leased embed job queue, and the embeddings client

Status: implemented

[English](2026-08-28-code-index-vector-core.md) | 中文

## Problem

Epoch 账本声明 `evidenceEpoch` 为"预留给语义证据摄入"，但没有任何东西写入它——第二个时钟存在的意义只是让缓存键在它预判的层级到来之前就能写对。检索本身停留在词法加图信号：跨文件改名的符号、与代码措辞不同的 query，都没有语义召回路径。而嵌入生成也不能简单地塞进一次刷新 pass——provider 慢、依赖凭据、且独立于索引失败——所以这一层需要持久化解耦才能参与排名。

## Decision

交付存储、队列与客户端核心（schema v4），检索接线留给[全链路 note](2026-08-28-code-index-vector-lane-full-link.md)：

- **两张表**（`code-index-sqlite/src/ddl.ts`）。`chunks_vec` 为每个 `(chunk_id, model)` 存一条 int8 量化嵌入：`q` 存量化分量的字节视图（每维一字节；按 BLOB 绑定契约，任何标量值绝不经过它），旁列 `scale`、量化前捕获的原始浮点 `norm`、`dim` 与反规范化的 `chunk_rowid`（读取侧按 rowid 对齐连接、无需查询）——受 `format = 'int8'` CHECK 与其余 chunk 拥有表同款的级联删除约束。`code_embed_jobs` 把索引与生成解耦：按 `(chunk_id, model, content_hash)` 加派生的 `dedupe_key` UNIQUE 幂等入队（`INSERT OR IGNORE`——同模型同文本的重入队是 no-op，内容修订是独立 job），job 随其 chunk 行级联删除，因此重切片会清掉陈旧 job 而不是留着它们对着被替换的文本失败；`result_json` 按契约恒为 NULL——已完成 job 的结果就是它的 `chunks_vec` 行，由 drain 在 evidence-epoch 事务内写入；只有 `usage_json` 记录 provider 的 `prompt_tokens` 花费。
- **带锁定存储契约的 int8 量化**（`code-index-search/src/vector-math.ts`）。逐向量对称量化把输入的最大绝对分量映射到 127，保持可表示范围 `[-127, 127]` 而非裸 int8 的不对称 `[-128, 127]`。排序从不物化反量化向量：`cosineQuantized` 直接在 int8 字节上算 `cosine = (scale · Σ query[i]·q[i]) / (|query| · norm)`，其精度来自"精确小整数 × 浮点 query 分量"的累加。解码重归一化到存储的原始 norm——对排名是 no-op（cosine 尺度不变），但对消费向量本身的调用方是诚实的模长。结果可能因量化误差略超 1；需要严格单位区间的调用方自行钳制。`fingerprintVector` 提供稳定的缓存键形态。
- **嵌入客户端**（`code-index-local/src/embed/client.ts`）。每个 `(baseURL, apiKey, model)` 一个 OpenAI 兼容客户端，跑在裸 `fetch` 上，沿用其他直连 fetch 适配器的 attribution 与有界读取约定。`embed` 把输入切分成至多 `min(batchSize, maxInputsPerRequest)`（默认 16）条文本的 wire 请求，每批配 caller 信号融合 30 s deadline，超过 4 MiB 的响应在解析前拒收，记录条数、顺序与维度逐一校验，并跨批累计 `usage.prompt_tokens` 供成本治理。所有失败映射到五个稳定码之一：`EMBED_RESPONSE_INVALID`、`EMBED_PROVIDER_ERROR`、`EMBED_INVALID_CREDENTIAL`、`EMBED_DIMENSION_MISMATCH`、`EMBED_ABORTED`。
- **租约守卫的队列与 drain**（`code-index-sqlite/src/embed-queue.ts`、`code-index-local/src/embed/worker.ts`）。`claimEmbedJobs` 在 `BEGIN IMMEDIATE` 下原子认领到期 job，带 `lease_owner` / `lease_until`（默认 60 s）：过期租约被回收，租约在最后一次尝试时过期则终止为 `failed`。`completeEmbedJob` 在未过期租约守卫下结算；`failEmbedJob` 把 job 退回 `pending`（最后一次尝试则终止 `failed`），带 `last_error` 与重试时刻（默认 1 s），消耗 job 的尝试预算。一次 drain 按认领 → 嵌入 → 量化 → 提交 → 结算推进；每个 job 在自己的 evidence-epoch 事务内提交，因此 N 个被 drain 的 job 恰好让 `evidenceEpoch` 前进 N 次而 `indexEpoch` 保持冻结——账本的 evidence 时钟正是向量层的修订计数器。drain 受 `maxJobsPerDrain`（256）与 `maxPromptTokensPerDrain`（200000）约束，确定性配置错误拒绝消耗尝试预算：它大声停止 drain。

## Consequences

`evidenceEpoch` 有了写入者族：drain，每 job 一次提交，刷新路径永不写。重嵌入一对 `(chunk_id, model)` 会替换其行；upsert 与完成结算同处一个 evidence-epoch 事务。evidence 时钟自此独立于内容提交前进，这正是[检索接线](2026-08-28-code-index-vector-lane-full-link.md)能把它们写进缓存键而不拖慢内容工作的前提。成本治理从 drain 粒度起步（job 与 prompt-token 预算）加逐 job 的用量记录——尚无墙钟或跨运行上限。

## Alternatives considered

- **存 float32 向量**——否决：每维四字节、无标量列听起来更简单，但 int8 存储契约每维一字节加三个 REAL，而 `cosineQuantized` 直接以精确整数点积读取它；存浮点会把向量层足迹翻四倍，只为省掉排序从不执行的解码步骤。
- **把 evidence 时钟并入 `indexEpoch`**——否决：向量写入与内容提交生命周期不同（嵌入慢、可重试、独立于工作区树失败）；单时钟会让每次 drain 前进内容 epoch，为从未变化的字节打碎全部 chunk 文本缓存条目。
- **把 job 队列留在进程内存**——否决：崩溃会丢弃 pending job 且没有欠账账本；持久化队列才是幂等重入队、chunk 级联清理与跨重启的租约过期回收得以成立的前提。
