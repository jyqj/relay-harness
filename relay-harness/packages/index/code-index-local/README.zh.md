# @relay-harness/rlh-code-index-local

[English](README.md) | 中文

Relay Harness 本地代码索引能力的文件系统 Service Provider：为一个工作区填充 `ctx.codeIndex`，组装其它包刻意不拥有的各层——树扫描、增量差分、五阶段 pass 背后的解析层与通用切片、脏传播、embedding 层（客户端、任务队列组合、排干器），以及在派生 SQLite 存储之上的存储/检索装配。

本包属于 code-index 能力：

| 包 | 角色 |
|---|---|
| `@relay-harness/rlh-code-index` | Service Definition：抽象服务、词汇类型、仓库规模分层 |
| `@relay-harness/rlh-code-index-local`（本包） | Service Provider：扫描/差分/解析/解析绑定/写入/脏传播五阶段管线装配在 `ctx.codeIndex` 之后 |
| `@relay-harness/rlh-code-index-sqlite` | 存储仓库：schema、随写递增的 epoch、检索端口适配器 |
| `@relay-harness/rlh-code-index-search` | 检索领域引擎：预选、lane、融合、rerank |
| `@relay-harness/rlh-tool-code-index` | Consumer：面向模型的 search/explore/status/refresh 工具 |

## 管线

单次 pass（`runRefreshPass`）按广度优先遍历工作区，用 mtime+size 快路径对照上一代分类每个文件；可疑候选重读一次做哈希二次确认（抑制 touch 误报与 mtime 抖动）。运行时提供 resolver 与 graph facet 时，pass 跑五个阶段：每个变更文件经 `parseFile` 解析（不支持或超限的文件回落通用层——至多 80 行的行窗、`generic` 解析层、置信度 0.5；无法解码的载荷按二进制跳过），新鲜的调用边在写入前对照常驻符号目录完成解析绑定，随后恰好提交一个携带逐文件导出指纹的 delta，执行 test-edge 重建决策，最后由脏传播阶段重解析每次导出面变化或删除的传递导入方。每个阶段的写入落在各自随写递增 epoch 的事务里，因此 pass 的 epoch 前进恰好等于其提交次数；全量构建不携带脏阶段。缺省 resolver 时退化为早期阶段的通用切片 delta。排除由三层独立叠加——内置硬排除与 include glob 逐字转录自参考实现的 `IndexingConfig` 默认值、解析后的根 `.gitignore`、显式 `exclude` 模式——并在下降前剪枝目录；symlink 一律不展开遍历。

并发在运行时边界折叠：并发的 `refresh` 调用者共享同一在途 pass 并接收其提交后的 summary。每次查询——检索或图探索——都通过惰性保证介质足够新鲜（`reason: 'lazy'`），而不是抛出 `CODE_INDEX_NOT_INDEXED`；epoch 从存储账本直接进入每份答案。`exploreGraph` 直接基于图读取面（`src/explore.ts`）回答 `relations` / `impact` / `tests` 三类问题：已解析符号的 caller/callee 沿端口按 seed 侧读取、窗口取分档每 seed 上限；`max` 对渲染节点做全局封顶（先 target，后边端点；第一次拒收即停止渲染并记录 `max_nodes`）；test 对走路径派生的 `test_edges`，按分档 `maxTests` 封顶（截断记 `result_limit`）；解析不到符号时返回空答案，并在 `explain.readErrors` 记一条 `symbol_not_found: <name>`——这是降级而非截断。分析类 op 与之并列：`cycles`（`src/cycles.ts`）对全库导入邻接运行迭代版 Tarjan SCC，只保留成员数大于一的组件，先按规模降序排列再应用 `max` 截断，按成员数分档 severity，并为每个组件附上 witness 导入边；`dead_code`（`src/dead-code.ts`）扫描 `min(40 × max, 5000)` 的有界符号超集（其反向调用/引用查找由存储按行计算），随后剔除入口名（`main`、`__init__`、`__main__`、`setup`、`configure`）、测试味名称前缀（`test_`、`Test`）以及所有有调用方或有外部引用的符号，幸存者以 `reason: 'no-callers'` 上报。检索经由 graph 包的 `searchWithGraphContext` 运行在组合图默认装配与分档富化限额、token 预算之上，连通的 chunk 可以凭加成越过其基础分；空图时富化解析不到任何符号，答案与普通管线一致。图结果缓存绑定在检索栈上，分档重组重建引擎时随之丢弃。工具结果经由带防抖的 stale pass 触发失效（默认 500 ms），可选的递归 watcher 把原生事件风暴折叠进同一条折叠管线——它只是延迟优化，正确性来自遍历本身。watch 无法建立时降级为 touch 驱动失效，并通过 `status().degraded` 上报。

存储路径默认 `<rlhHome>/index/code-index-<hash>.sqlite3`，`<hash>` 是工作区 realpath 的 SHA-256 前 12 个十六进制字符；`$RLH_HOME` 或显式 `databasePath` 可覆盖。

配置了 embedding 层时，每次提交后的 pass 把本批变更 chunk 行（chunk id 联接其文件内容哈希）写入存储队列，并启动一个自身单飞的排干，与 refresh 调用方解耦。检索时把裁剪后的查询文本嵌入（经 32 条 LRU 记忆化，键为模型、维度与文本哈希）放进引擎请求，vector lane 在 `chunks_vec` 上用量化余弦对其余 lane 构建的候选池重打分。图结果缓存以查询向量的内容指纹入键，因此向量在 evidence clock 前进后落库时答案会重算而非读取陈旧缓存。查询嵌入失败只降级该次答案（记入 `readErrors`，不伪造向量贡献），不粘置 `status().degraded`；只有整 lane 中止（`<laneId> lane failed`，例如存量向量维度与嵌入器矛盾）才是粘性的。排干与入队失败绝不使已提交的 refresh 失败，而是经由运行时内部的 `vectorStatus()` 投影（模型、积压、覆盖率、最近排干错误）呈现——seam 状态报告保持不动。

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `workspaceRoot` | 进程工作目录 | 每次 pass 扫描的工作区 |
| `databasePath` | 推导到 `<rlhHome>/index/` 下 | 专用 SQLite 文件，或 `:memory:` |
| `journalMode` | `wal` | 透传给打开器的 SQLite journal pragma |
| `exclude` | `[]` | 叠加在硬排除之上的额外 `.gitignore` 语法排除 |
| `maxFileBytes` | `512000` | 文件超过此字节数后只记行不入 chunks |
| `debounceMs` | `500` | 工具结果失效防抖 |
| `watcherEnabled` | `false` | 可选的递归文件系统 watcher |
| `dirtyPropagationMaxFiles` | `200` | 单次 pass 脏传播提升文件的全局预算 |
| `embedding` | — | embedding 层；缺省 `baseURL` 或 `model`（或整段缺省）时整体移除 vector lane、排干与向量状态 |

误配置在加载时响亮失败：工作区根必须是已存在目录，数值参数必须为正安全整数。

`embedding` 接受 `apiKeyEnv`（credential-ref，指明承载 bearer key 的环境变量，默认 `EMBEDDING_API_KEY`）、`baseURL`、`model`、`dimensions`（缺省则锁定首个回复的维度）、`batchSize`（`32`）、`timeoutMs`（`30000`）、`maxInputsPerRequest`（`16`）、`maxPromptTokensPerDrain`（`200000`）、`maxJobsPerDrain`（`256`）、`vectorWeight`（`0.9`；`0` 静默该 lane）、`vectorTopK`（`12`）与 `vectorMaxCandidates`（`2000`）。已配置但运行期不可达的端点按操作降级；空白凭据在每次尝试时经 `EMBED_INVALID_CREDENTIAL` 响亮失败。

## Embedding 层

`src/embed/` 承担从 chunk 文本到落库 int8 向量的完整路径。`EmbeddingClient` 以 OpenAI 兼容的 `POST /embeddings` 形状对接单个 `(baseURL, apiKey, model)` 端点：把输入切分为每请求至多 `min(batchSize, maxInputsPerRequest)` 条文本的线级请求，每批装配调用方信号加截止时间的融合信号，校验记录数量、顺序与维度（配置的 `dimensions`，或首个回复的维度——后者将客户端终身锁定），并累计 `usage.prompt_tokens`。失败携带稳定码——`EMBED_PROVIDER_ERROR`（HTTP 错误、传输失败）、`EMBED_ABORTED`（调用方取消）、`EMBED_TIMEOUT`（线级请求截止时间已到）、`EMBED_RESPONSE_INVALID`（非 JSON、超出 4 MiB 读取上限、数量不匹配）、`EMBED_DIMENSION_MISMATCH`、`EMBED_INVALID_CREDENTIAL`——排干器据此路由而非解析消息；同一调用中前序批次已计费的失败会在 `error.promptTokensUsed` 上携带其花费。

`drainEmbedJobs` 把存储包的 `code_embed_jobs` 队列与客户端及 search 包的 int8 量化器组合起来：对每个领取的任务，读取 chunk 文本、嵌入、量化、在单个证据 epoch 事务内提交 `chunks_vec` 行（每任务恰好一次时钟前进），并携带记录的 usage 完成结算。token 预算在每次领取前检查，排干器绝不启动付不起的工作。调用方中止会停止排干且不结算在途任务（其租约过期后交给后续认领）；线级截止时间（`EMBED_TIMEOUT`）按尝试预算结算任务——部分花费写入 `usage_json`——排干器继续下一个任务；确定性失败（`EMBED_DIMENSION_MISMATCH`、`EMBED_INVALID_CREDENTIAL`）会结算任务后大声终止排干，而不是烧光整队的尝试预算。量化器可注入，缺省为 `quantizeInt8`。提供方只在配置了该层时把它接入检索：vector lane 在组合默认装配中注册在 literal 之后，用量化余弦对其余 lane 构建的候选池（按 `vectorMaxCandidates` 封顶）对照记忆化的查询嵌入重打分；`EmbeddingClient` / `embedQueryVector` / `drainEmbedJobs` 均接受结构化的嵌入器表面，部署可以组合其它嵌入器。

## Model Experience

间接地，通过 `search_code_index`、`explore_code_graph`、`code_index_status`、`refresh_code_index` 工具呈现：模型看到的命中与图探索答案来自本包组装出的 chunk、symbol 与边。

#### KV Cache 效果

对请求前缀无直接影响；索引 epoch 单调递增且消费者以 epoch 对为缓存键，既有会话缓存保持有效。

## 已知限制与延后工作

- **本机 fixture 的首次全量索引成本** — REAL 组合测试测得 9 文件 fixture 三次全量 pass 的中位数为 5 ms（约 0.56 ms/file）；更大的语料从未被认证，因为真实仓库目前会踩中解析写入侧的 UNIQUE 冲突。
- **explore 忠实投影已存边，包括瑕疵** — 每个函数在声明行都有一条自环调用边（解析器的 regex 兜底 lane 把 `name()` 参数表读成了调用点），`explore_code_graph` 的答案会包含它；过滤属解析侧职责，不在读取侧做。
- **存储根推导是过渡方案** — 带 workspace 哈希的文件名避免多 checkout 互踩，但还不是计划中的可配置 storage-root 布局；其落地时会一并迁移。
- **watcher 降级刻意安静** — 失败即退到 touch 驱动失效并只留下一个 `status()` 标志；事件相对 pass 也可能滞后一个防抖窗口。
- **嵌套 `.gitignore` 不读取** — 只有工作区根的文档生效。
- **一个 store 服务一个工作区** — 将两个工作区指向同一显式 `databasePath` 的部署会交错各自代际。
- **embedding 成本治理按排干计，而非按月** — 花费可见性来自每个完成任务记录的 `usage_json`，加上排干器的 `maxJobs` / `maxPromptTokens` 预算与 `pendingEmbedCount` 积压表；没有按月或累计的预算核算，在出现需要的消费者之前也不计划。
