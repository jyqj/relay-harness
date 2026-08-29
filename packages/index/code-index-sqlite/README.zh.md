# `@relay-harness/rlh-code-index-sqlite`

[English](README.md) | 中文

本地代码索引能力的 SQLite 存储库：`ctx.codeIndex` 背后可重建的派生磁盘介质。本包端到端承担存储生命周期——对数据库文件做 fail-closed 准入（属己但失配时原地重建）、`(text_encoding, text)` 列位之上的 chunk 文本编解码、三个独立时钟通道每事务恰好一次的 epoch 提交包装、增量文件 delta 写入器、int8 向量层及其 embedding 任务队列、LRU 解码文本缓存，以及排序引擎消费的读取侧检索适配器。扫描/diff 编排、排序以及一切面向模型的行为属于 provider 与 consumer 包，均不在此处。本包不注册服务、不挂载插件入口、也不暴露 Config。

## 存储布局

schema 版本 8（`CODE_INDEX_SQLITE_SCHEMA_VERSION`，`src/ddl.ts`）保留 chunk/graph/literal 层与 zstd chunk codec，并以持久化 `embedding_generations`、generation-keyed job/vector 及独立 Embedding 时钟替代仅按 model 的向量身份：

- `metadata` — 跨重启标量的 KV 账本；三个时钟（`index_epoch` / `evidence_epoch` / `embedding_epoch`）以 `'0'` 播种并在重开时保留，逐文件导出指纹存放于 `export_fingerprint:<filePath>` 键下：delta writer 对字符串写入整体替换，对 `null`（导出面清空）清除条目，对 `undefined` 保持不动。`src/epoch.ts` 独占这三个时钟：`bumpIndexEpochOnceInTx` 把恰好一次的计数推进折叠进每个内容事务、作为 COMMIT 前最后一条语句执行；`bumpEvidenceEpochOnceInTx` 保留运行时证据通道，`bumpEmbeddingEpochOnceInTx` 则推进向量物化批次；`readEpochs` 遇到缺失或不可解析的账本行即抛错而非回零；`assertExactAdvance` 以声明的通道审计一次提交（`epoch_rules.rs` 语义）：被声明的时钟恰好前进一次，兄弟时钟保持冻结。
- `files` / `chunks` — STRICT 行源；chunks 通过 `ON DELETE CASCADE` 引用所属文件，标识为 `chunk:<file>:<index>`。列位与参考布局一致。
- `chunks_fts` / `files_fts` / `file_paths_fts` — chunk 文本与文件摘要之上的 FTS5（`unicode61 remove_diacritics 2`），外加 trigram 路径查找。应用层维护遵循 `src/writer.ts` 实现的参考规则：镜像删除先于基表行消失、经基表解析出待删 rowid；插入按基表自身 rowid 重新镜像（最外层语句的 `lastInsertRowid` 不受触发器内插入影响）；仅 `file_paths_fts` 单靠触发器自愈。
- `symbols`（附 trigram 镜像 `symbols_fts`）、`imports`、`symbol_refs`、`call_edges`、`test_edges`、`literal_index`（v3 附 `literal` / `literal_kind` 之上的 `literal_fts` 镜像）— STRICT 图行；每个文件所有的表都随其 `files` 行级联删除。`symbols_fts` 由 insert/delete/update 触发器自维护；writer 仍在级联之前显式删除 `symbols` 行，随后级联删除命中的是零行（绝不双删）。`literal_fts`（`unicode61`）沿用同一触发器模式自愈，可空的镜像列合并为 `''`——FTS5 拒绝 NULL 列值。`test_edges` 是路径对而非文件所有行，文件移除后保留；metadata 中的指纹条目由 writer 逐文件清理。图列全部裁剪到图读取面实际消费的集合。图层级在文件 delta 之外还有两个写入面：`writeResolvedEdges`（`src/writer.ts`）面向脏重解析，只整体替换一个文件的 `call_edges` / `symbol_refs` 行集；`src/test-edges.ts` 承担路径对重建（`rebuildTestEdgesForFiles` 在单个 epoch 提交事务内修复变更端点，`rebuildTestEdgesFull` 在内存中重算全部路径对），共享 `testStemCandidateFragments` 的词干片段与 LIKE 匹配语义。

向量层在 `chunks_vec` 中为每个 `(chunk_id, generation_id)` 存一条 int8 量化向量，并以该复合主键约束——同一 chunk 不同 embedding generation 的向量以兄弟行共存——`q` 列存 search 包量化分量的字节视图（每维度一字节；标量绝不经过 BLOB 列），旁边是 `scale`、量化前的原始浮点 `norm`、`dim` 与反规范化的 `chunk_rowid`，并受 `format = 'int8'` CHECK 与随 chunk 级联的外键约束。`writeChunkVectors`（`src/writer.ts`）把一批向量放进单个 Embedding epoch 事务提交，因此一个 drain 批次恰好使 `embedding_epoch` 前进一次，而 `index_epoch` 与运行时 `evidence_epoch` 冻结；重复嵌入同一 `(chunk_id, generation_id)` 只替换该对的行，且 `q.byteLength` 与 `dim` 矛盾的行会使整批中止（`CODE_INDEX_VECTOR_ROW_INVALID`）。编码/解码数学位于 `@relay-harness/rlh-code-index-search/vector-math`（`quantizeInt8` / `dequantizeInt8` / `cosineQuantized`）；存储层只负责强制契约。

embedding 任务队列（v4，`code_embed_jobs`，`src/embed-queue.ts`）把 chunk 索引与向量生成解耦。入队按 `(chunk_id, generation_id, content_hash)`（外加派生的 `dedupe_key` UNIQUE）经 `INSERT OR IGNORE` 幂等；每个任务随其 chunk 行级联消失，因此重切一个文件会清掉陈旧任务，而不是留着它们对已替换文本失败。`claimEmbedJobs` 在 `BEGIN IMMEDIATE` 下原子领取到期任务——过期租约可被回收，而最后一次尝试上的租约过期会终态为 `failed`；`completeEmbedJob` 在未过期租约守卫下记录 `usage_json`，`failEmbedJob` 把任务送回 `pending`（最后一次尝试则终态 `failed`）并记录 `last_error`、重试时刻，以及可选的失败前已计费花费（`usage`，合并写入 `usage_json`）。`result_json` 按契约恒为 NULL：已完成任务的结果就是它的 `chunks_vec` 行。`pendingEmbedCount` 上报单个 generation 的积压；当前源码哈希仍匹配的终态失败 job 经 `resetFailedEmbedJobsForGeneration` 获得一次持久化 `reconcile_resets` 重置，既避免永久静默覆盖洞，也避免无限重试；`embedChunkInputs` 为排干器分批读出解码后的 chunk 文本与 rowid。

准入（`src/open.ts`）对外来数据库抛错拒绝（`CODE_INDEX_DB_FOREIGN_APPLICATION`）：非零的外部 `application_id`，或未登记 id 下存在用户表的文件，原样拒收。属己库若版本越界或携带未知表则原地重建而非迁移——这里的每张表都是可重建的派生数据，字节正确性优先于兼容垫片。缺失目录与文件按 owner-only 创建（`0700`/`0600`）；失败路径先关闭句柄再抛错。打开的句柄以 `foreign_keys = ON`、5 秒 `busy_timeout` 与调用方指定的 journal 模式运行。

编解码器（`src/codec.ts`）在 `chunks` 的 TEXT 列对上登记两种编码。`'plain'` 原样存储文本；`'zstd'` 把 Zstandard level-3 帧以 base64 文本存储，使 payload 保持列的 TEXT 契约，读取端与 embedding 排干器始终经由编解码器解码。编码器遵循参考实现策略：不超过 128 个 UTF-8 字节的 payload 保持 plain，更大的候选项做压缩，压缩结果未缩小到原文之下的回退 plain。读取端拒绝猜测：未登记的存储标签，或解压失败的 `'zstd'` payload，都会抛出 `CODE_INDEX_SCHEMA_VERSION_UNSUPPORTED`。`chunks_fts` 镜像始终写入解码后的文本，因此无论基行以何种编码存储，检索匹配的都是明文。writer 输入是调用方生成的解析产物（`FileUpsert`：summary、摘录、parser 层级/置信度、测试标记——由 provider 扫描器生成，存储层不代拟）。

读取端（`src/reader.ts`，`createRetrievalPort`）以裸 SQL 实现 search 包的 `RetrievalPort`：带移植列权重的 bm25 排序 FTS 匹配、渲染成 WHERE 子句的结构化 scope 过滤（LIKE 元字符转义；语言子句测试 `files.language`，因此 `lang:` DSL scope 在 SQL 中强制）、无文件 scope 时按 `rowid DESC` 的近期优先 grep 流式扫描逐行惰性解码、经 `literal_fts` 的 bm25 排序字面量匹配（`literalFtsCandidates`）、以及分批的整行取回。符号 token 查询（`symbolNamesByTokenSubstring`）与 `graph` 读取面（`createGraphReadFacet`：符号种子、按名/按 uid 解析、逐 seed 截断的 caller/callee 边窗口、度数、chunk 跨度、imports、完整逐文件边重载、导入方反向查询、已解析 re-export 目标、受影响测试、指纹、字面量）读取图层级——种子来自 `symbols_fts` trigram LIKE 且大小写不敏感精确命中优先，逐 seed 边上限以 `ROW_NUMBER()` 窗口实现，所有 id 列表先去重、排序、再按 `IN (...)` 分批。存储侧职责止于排序、scope 与按需解码；扫描预算归 search 侧，遵从 port 契约。只有被访问到的行支付解码成本，且每个解码文本落入 LRU 缓存（`src/cache.ts`）——槽位键含 `(index_epoch, chunks.rowid)`，任何提交都会自然失效。缓存容量是本包自主决策，按仓库规模分层伸缩：tiny/small/medium/large 分别 128/256/384/512 条（`chunkTextCacheCapacityForTier`）。降级读结果绝不入缓：缓存写入只接受持有新鲜度对的调用方。

## 错误

稳定错误码用于程序化路由，请勿解析消息文本。

| Code | 触发条件 |
|---|---|
| `CODE_INDEX_DB_FOREIGN_APPLICATION` | 数据库属于其他应用：外部 `application_id`，或未登记 id 下存在用户表。 |
| `CODE_INDEX_SCHEMA_VERSION_UNSUPPORTED` | 派生介质携带本层未登记的状态：未知 `text_encoding` 标签、解压失败的 `'zstd'` chunk payload、丢失或被手改的 epoch 账本行、或违反声明 epoch 规则的被审计提交。 |
| `CODE_INDEX_VECTOR_ROW_INVALID` | `writeChunkVectors` 的行违反存储契约：`q.byteLength` 与声明的 `dim` 矛盾。 |

## Model Experience

间接地，通过 provider 从本存储读出排序命中的 `search_code_index` 与 `code_index_status` 工具。

#### KV Cache 效果

无；本库决定哪些记录存在、chunk 文本如何解码，但其自身从不进入请求前缀。

## 已知限制与延后工作

- **重建丢弃已确认状态**——版本漂移或清单异常的属己库会不经确认地清空派生内容（含已提交的 epoch），这对派生介质是正确行为，但持久源的恢复责任完全落在其上的 provider。
- **同步语句**——`DatabaseSync` 在语句执行期间阻塞 JavaScript 线程。
