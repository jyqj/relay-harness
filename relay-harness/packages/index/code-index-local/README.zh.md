# @relay-harness/rlh-code-index-local

[English](README.md) | 中文

Relay Harness 本地代码索引能力的文件系统 Service Provider：为一个工作区填充 `ctx.codeIndex`，组装其它包刻意不拥有的各层——树扫描、增量差分、五阶段 pass 背后的解析层与通用切片、脏传播、embedding 层（客户端、任务队列组合、排干器），以及在派生 SQLite 存储之上的存储/检索装配。

本包属于 code-index 能力：

| 包 | 角色 |
|---|---|
| `@relay-harness/rlh-code-index` | Service Definition：抽象服务、词汇类型、仓库规模分层 |
| `@relay-harness/rlh-code-index-local`（本包） | 显式单 Workspace Provider 与可复用 `LocalCodeIndexRuntime` |
| `@relay-harness/rlh-code-index-workspace-router` | 多 Workspace Provider：每个规范 Session cwd 使用一份本 runtime/store |
| `@relay-harness/rlh-code-index-sqlite` | 存储仓库：schema、随写递增的 epoch、检索端口适配器 |
| `@relay-harness/rlh-code-index-search` | 检索领域引擎：预选、lane、融合、rerank |
| `@relay-harness/rlh-tool-code-index` | Consumer：面向模型的 search/explore/status/refresh 工具 |

已建立的原生 watcher 发出错误时，会关闭其句柄并取消待处理变更通知。watcher 与所属 Provider 会进入降级状态；手动刷新与工具结果失效仍可用。已退役句柄的晚到错误或变更事件不能改变新的生命周期状态，也不能再次安排刷新。

## 管线

单次 pass（`runRefreshPass`）以有界并发 stat 按广度优先遍历工作区，用 mtime+size 快路径对照上一代分类每个文件；可疑候选以有界并发哈希做二次确认（抑制 touch 误报与 mtime 抖动）。运行时提供 resolver 与 graph facet 时，pass 跑五个阶段：变更文件以保持确定顺序的四路并发经 `parseFile` 解析（不支持或超限的文件回落通用层——至多 80 行的行窗、`generic` 解析层、置信度 0.5；无法解码的载荷按二进制跳过），新鲜的调用边在写入前对照常驻符号目录完成解析绑定，随后恰好提交一个携带逐文件导出指纹的 delta，执行 test-edge 重建决策，最后由脏传播阶段重解析每次导出面变化或删除的传递导入方。每个阶段的写入落在各自随写递增 epoch 的事务里，因此 pass 的 epoch 前进恰好等于其提交次数；全量构建不携带脏阶段。缺省 resolver 时退化为早期阶段的通用切片 delta。硬排除与显式 `exclude` 模式保持静态层。每次 pass 都会加载仓库本地 `.git/info/exclude`（包括 linked worktree 的 common Git 目录），并在遍历时发现根目录及嵌套 `.gitignore`；仓库本地文档优先级较低，随后 ignore 文档按根到叶顺序生效，因此更晚的否定规则可以恢复其路径。被排除的目录在下降前剪枝，symlink 一律不展开遍历。`RefreshOptions.paths` 将扫描、diff 与删除集合限制在规范化后的工作区相对文件或目录前缀。

每次刷新都携带 `BuildExplain`：全量/定域决策、请求路径数、执行/跳过、dirty closure 状态与预算降级，以及 generation 回填和 Embedding 批次/job 完成数。无 delta 的 pass 跳过写事务且不推进 `indexEpoch`；status 保留异步完成后的 Embedding 计数。

并发在运行时边界折叠：并发的 `refresh` 调用者共享同一在途 pass 并接收其提交后的 summary。每次查询——检索或图探索——都通过惰性保证介质足够新鲜（`reason: 'lazy'`），而不是抛出 `CODE_INDEX_NOT_INDEXED`；epoch 从存储账本直接进入每份答案。`exploreGraph` 直接基于图读取面（`src/explore.ts`）回答 `relations` / `impact` / `tests` 三类问题：已解析符号的 caller/callee 沿端口按 seed 侧读取、窗口取分档每 seed 上限；`max` 对渲染节点做全局封顶（先 target，后边端点；第一次拒收即停止渲染并记录 `max_nodes`）；test 对走路径派生的 `test_edges`，按分档 `maxTests` 封顶（截断记 `result_limit`）；解析不到符号时返回空答案，并在 `explain.readErrors` 记一条 `symbol_not_found: <name>`——这是降级而非截断。分析类 op 与之并列：`cycles`（`src/cycles.ts`）对全库导入邻接运行迭代版 Tarjan SCC，只保留成员数大于一的组件，先按规模降序排列再应用 `max` 截断，按成员数分档 severity，并为每个组件附上 witness 导入边；`dead_code`（`src/dead-code.ts`）扫描 `min(40 × max, 5000)` 的有界符号超集（其反向调用/引用查找由存储按行计算），随后剔除入口名（`main`、`__init__`、`__main__`、`setup`、`configure`）、测试味名称前缀（`test_`、`Test`）以及所有有调用方或有外部引用的符号，幸存者以 `reason: 'no-callers'` 上报。检索经由 graph 包的 `searchWithGraphContext` 运行在组合图默认装配与分档富化限额、token 预算之上，连通的 chunk 可以凭加成越过其基础分；空图时富化解析不到任何符号，答案与普通管线一致。图结果缓存绑定在检索栈上，分档重组重建引擎时随之丢弃。工具结果经由带防抖的全量 stale pass 触发失效（默认 500 ms）；可选的递归 watcher 则保留、去重并合并原生事件路径，形成路径定域 pass；`.gitignore` 变化会扩宽回全量扫描。watcher 仍只是延迟优化，正确性来自遍历本身。watch 无法建立时降级为 touch 驱动失效，并通过 `status().degraded` 上报。

`hydrateChunks` 让源码交付保持在 search result 与 graph cache 之外。它批量读取完整解码 chunk，按首次出现顺序去重请求 id，从词法路径与规范真实路径两层把每条存储路径限制在工作区内（拒绝父目录 symlink 逃逸），并对每个不同的当前普通文件重新哈希一次。只有哈希与已索引 revision 一致时才返回 `source-verified` 正文；缺失索引行、非法/不可读路径以及 watcher 延迟造成的哈希漂移分别返回稳定的 `unavailable` / `stale` rejection。每次文件系统读取前后都会检查取消信号。

存储路径默认 `<rlhHome>/index/code-index-<hash>.sqlite3`，`<hash>` 是工作区 realpath 的 SHA-256 前 12 个十六进制字符；`$RLH_HOME` 或显式 `databasePath` 可覆盖。`forWorkspace(root)` 会规范化并且只接受本 Provider 配置的根目录，因此单 Workspace 部署不会意外回答其他 Session cwd。

配置了 embedding 层时，provider 会持久注册 `EmbeddingGeneration`：其 SHA-256 身份覆盖 provider、无凭据 endpoint 身份、模型、固定/服务端默认维度模式、归一化、量化器与 chunker 版本。每次打开及刷新提交后，coverage reconciler 计算“当前 chunks 减去该 generation 已有向量”，将差集入队并启动与 refresh 调用方分离的折叠 drain；后来启用 Embedding 或切换 endpoint/model/dimensions 都会回填未变化 chunk。检索只读取该 generation，图结果缓存以查询向量和三时钟快照入键；向量批次推进 `embeddingEpoch` 后答案重算，但不会伪称运行时证据变化。查询嵌入失败只降级该次答案，排干与入队失败经运行时内部 `vectorStatus()` 呈现。

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

`drainEmbedJobs` 把存储队列、client 与 int8 quantizer 组合成真实批处理：一个租约事务 claim N 个 job，批量读取文本、共同 embed（client 可按 endpoint 上限拆线请求）、量化、在一个事务写入全部向量，再以精确分摊的聚合 usage 逐个 settle。每个成功写批次只推进一次 `embeddingEpoch`；`evidenceEpoch` 为未来运行时证据保留且保持不变。token 预算在每个 claim 批次前检查，因此末批最多只会超出自身服务端报告的花费。源码 revision 仍当前的终态失败 job 只获得一次持久化 reconciliation reset（`reconcile_resets < 1`），错误凭据不会无限循环。调用方中止保留在途租约待过期；超时按尝试预算结算，确定性配置失败则结算整批后大声停止。 活跃 drain 期间提交的 refresh 会设置一次排干后观察位，关闭最终空 claim 的丢失唤醒窗口且不会重复 claim；`embedDrainIdle()` 会沿后续 generation 等到真正静止。

## 检索评测

`evaluateRetrieval(index, corpus)` 通过公开 `search` seam 执行相关性判断，报告宏平均 Recall@5/MRR 及逐 case 排名。检入的 TypeScript、Python、Go fixture 仓库、本包真实工作区与定域增量样本形成快速可执行门禁。可重复的真实仓库 runner（`pnpm run eval:code-index:corpus`）读取检入 manifest，而不复制 corpus 源码：Relay monorepo 是 required CI corpus；已授权 CodeCortex/Auggie checkout 默认 optional，除非显式选择或通过环境变量提供。增量 probe 使用排他创建，不删除非自身创建的路径；即使某项清理失败，runner 仍会尝试清理 probe、runtime 与临时存储。runner 通过公开 runtime seam 测量全量索引、七次定域提交、重复搜索延迟、parser tier/文件/chunk 覆盖、致命 parser 失败及文件级 Recall@5/MRR。

## Model Experience

间接地，通过 `search_code_index`、`explore_code_graph`、`code_index_status`、`refresh_code_index` 工具呈现：模型看到的命中与图探索答案来自本包组装出的 chunk、symbol 与边。

#### KV Cache 效果

对请求前缀无直接影响；索引 epoch 单调递增且消费者以 epoch 对为缓存键，既有会话缓存保持有效。

## 已知限制与延后工作

- **性能证据可执行但并非普适**——2026-08-30 Apple Silicon 实测真实 Relay checkout：8,440 文件 / 87,184 chunks，全量 55.19 s，增量 p95 31 ms，搜索 p50/p95 0.043/0.079 ms，Recall@5 0.80、MRR 0.60、致命 parser 错误为零。可选 CodeCortex Rust checkout：366 文件 / 5,523 chunks，全量 3.16 s，增量 p95 8 ms，搜索 p50/p95 0.044/0.059 ms，Recall@5/MRR 1.00/1.00、致命 parser 错误为零。可选 Auggie 恢复源码 checkout：1,705 文件 / 88,028 chunks，全量 88.52 s，增量 p95 13 ms，搜索 p50/p95 0.044/0.052 ms，Recall@5/MRR 0.50/0.50、致命 parser 错误为零。这些是单机观测，不是普适容量声明；应在目标 CI/硬件上重跑 manifest gate。
- **explore 忠实投影已存边，包括瑕疵** — 每个函数在声明行都有一条自环调用边（解析器的 regex 兜底 lane 把 `name()` 参数表读成了调用点），`explore_code_graph` 的答案会包含它；过滤属解析侧职责，不在读取侧做。
- **存储根推导是过渡方案** — 带 workspace 哈希的文件名避免多 checkout 互踩，但还不是计划中的可配置 storage-root 布局；其落地时会一并迁移。
- **watcher 降级刻意安静** — 失败即退到 touch 驱动失效并只留下一个 `status()` 标志；事件相对 pass 也可能滞后一个防抖窗口。
- **构建并发有界而非无限**——stat 使用 16 槽、哈希 8 槽、读取/解析 4 槽且保持确定输出；不安全 watcher 事件仍扩宽为全量扫描。
- **一个 store 服务一个工作区** — 将两个工作区指向同一显式 `databasePath` 的部署会交错各自代际。
- **embedding 成本治理按排干计，而非按月** — 花费可见性来自每个完成任务记录的 `usage_json`，加上排干器的 `maxJobs` / `maxPromptTokens` 预算与 `pendingEmbedCount` 积压表；没有按月或累计的预算核算，在出现需要的消费者之前也不计划。
