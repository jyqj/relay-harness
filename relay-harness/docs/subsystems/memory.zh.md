# 长期记忆

[English](memory.md) | 中文

长期记忆在多个 Agent 会话之间保存受治理的知识，但不替代产生知识的追加式 SessionEvent 证据。[`@relay-harness/rlh-memory`](../../packages/memory/memory) 负责 Provider 无关的 `ctx.longTermMemory` 与 `ctx.memoryExtractionQueue` seam；[`memory-sqlite`](../../packages/memory/memory-sqlite) 是随附的单一 Owner；[`memory-agent`](../../packages/memory/memory-agent)、[`memory-extractor-llm`](../../packages/memory/memory-extractor-llm) 与 [`tool-memory`](../../packages/memory/tool-memory) 是相互独立的 Consumer。

## Scope 与标识

每个操作都提供精确的 `MemoryScope`：工作区、用户和稳定 Agent 标识。Session id 是证据和轮次结算标识，不是长期 Scope；相同 Scope 的会话可以互相召回。标准 preset 从会话 cwd 派生工作区，使用本地操作系统用户名，并把 Agent id 固定为 `relay-harness`。

`MemoryId` 标识一条逻辑记忆。id 保持稳定，`revision` 递增。Provider 保留每个完整版本，并独立物化当前条目及其召回索引。

## Kind、状态与信任

Kind 区分偏好、事实、约束、决策、流程和教训。项目与用户身份属于 Scope，而不是 kind；实时任务状态留在记忆之外。

状态为 `candidate`、`active`、`disputed`、`superseded` 或 `tombstoned`。主动召回只读取未过期 active 条目。Active 条目要求 `user-stated` 或 `action-verified` 信任，并带有匹配的持久证据。Agent proposal 和外部观察保持 candidate 或 disputed，直到其他可信 Consumer 审核。

## 证据与版本

每次写入都会引用一个 Session id 和非空的早期 event seq。用户陈述证据指向直接用户消息；行动验证证据指向成功工具结果及其调用。新版本绝不替换或删除前置版本。遗忘会追加 tombstone，并从 FTS 移除当前条目，同时保留按精确 id 的审计读取。

模型工具要求精确证据引文后才会请求 active 状态；Provider 会重复执行 trust／evidence 与 secret 检查，因此其他 Consumer 不能绕过该决策。

## Context Provider 与召回生命周期

Host-owned `memory-agent` 会注册一个 Context Engine Contributor。`StepContextInput.caller` 携带分离的持久 session、turn／step、workspace、origin 与有效 preset identity；发行策略只接纳 `standard` 顶层会话。在首个 Agent step，Contributor 从直接用户文本准备候选，把保留条目序列化为不受信任 JSON，并返回具有独立来源的消息、绑定 revision 的 Memory Evidence 与有界 coverage。AgentLoop 会在 `context/prepared` 中记录被接纳消息以及 Evidence／提议接纳关系。Provider 失败采用 fail-open，不修改直接提示。

Prepared handle 保持打开，直到最终 `turn/end`。Completed 与 max-token 轮次只提交依据持久 trace 证明其原始提议精确通过 `agent/pre-step` 的 id；提议被移除或改写时不提交 injected id。error、abort、interruption、缺少 Assistant 输出、替换、卸载，或 Provider prepare 与 pending ownership 之间的失败都会执行 abort。Evidence digest 覆盖完整注入 item payload。SQLite Provider 幂等保存结算，并记录 candidate-hit 和 injected 信号。

对于 Prompt Enhancement，同一 Contributor 会在相同字符预算与来源格式下执行 active、未过期、精确 Scope 的搜索。它传入 `recordAccess: false` 且绝不调用 prepare／commit／abort，因此预览未发送草稿不会改变记忆计数／turn 状态，也不会改动目标 Session 日志。

Recall-form 用户消息保留在原始 Session 日志中，但不会生成 Session Query 语义文档。这会阻止已召回记忆或被引用 Session 快照变成新的 episodic 证据并递归放大自身。

## 自动提取生命周期

自动提取是 Host Consumer，而不是隐藏的 Agent-loop mutation。其包级默认关闭；发行的 base 组合只对带持久 `standard` preset identity 的会话显式开启，并排除 subagent。completed 或 max-token `turn/end` 到达时，capture 只投影直接用户消息和成功工具结果。派生 recall/plugin 消息、reasoning、失败结果、memory/session/skill 工具输出以及含 secret 的来源会在持久化前排除。

有界 source snapshot 与辅助 route 会进入按 Scope、session、turn 和 source hash 幂等的持久 job。SQLite 原子领取最早可用 job，持久记录 attempts 与有期限 lease，重新领取被中断工作，对畸形输出、模型或 Provider 故障重试，并跨重启保存 completed 或 terminal 状态。成功结果只保留 memory id、计数与模型 output hash；原始模型输出不会成为另一份 truth source。

辅助调用使用 `purpose: 'memory-extraction'`、固定的仅 JSON 指令、无工具且无对话历史。提案会被严格解析。直接用户来源中的精确连续引文可成为 user-stated active memory；allowlist 内成功本地工具结果中的精确引文可成为 action-verified active memory。自动 active 内容就是精确引文，而非模型改写。非 allowlist 的成功 observation 与无法 grounding 的提案保持 candidate。Provider 侧 trust、evidence、Scope、secret 与精确去重检查在每次重试中仍是权威边界。

## SQLite 检索

本地 Provider 为当前非 tombstoned 条目维护 Unicode 与 trigram FTS5 索引。它融合各渠道排名，再应用有界 importance 和 trust 权重。查询和每个元数据筛选器都是 SQL 参数；调用者 Scope 为必填。`SearchMemoryInput.recordAccess` 默认为 true，而设为 false 的辅助预览保持只读。规范数据库会拒绝无关文件和未知 schema 版本，而不是重置它们。schema version 2 增加确定性 content hash 与提取 job；version 3 增加单 owner 心跳表。更早的 store 会原地迁移。

## Memory Center 与剩余缺口

发行的 Web composition 现在会挂载受治理 Memory Center。每次分页 list/search/read 都由已连接 Host Session 授权，其 cwd 必须匹配 Client workspace Scope；recall accounting 保持不变。candidate/disputed approve 或 reject、带用户 Evidence 的 revision 和 tombstone deletion 都携带页面展示的 revision。Client cache 与 Settings UI 会展示所有 canonical status、来源 excerpt、`validUntil` freshness、显式 supersession 链，以及带 current/historical revision 状态的跨 Session why-used occurrence。治理写入会追加 `memory/governance-requested`，要求 Session durability，并在 Provider 写入前重新检查 revision；浏览器无法虚构 active user-stated memory，也不能覆盖更新的治理。

Memory Center 现在扫描同工作区完整 Session Query corpus 且不激活 Agent，并把读取失败明确标为 partial coverage。按 generation 分区的 Client cache 会拒绝过期在途填充；并发 revision 重排分页边界时，多页 substring search 会重新开始。Canonical signal 会暴露 retrieval、injection、用户确认与用户拒绝。Candidate review 会先执行确定性 normalized content/summary collision detection，再查询 optional attributed semantic detector。SQLite version 4 保存幂等 per-Session outcome；显式 Assistant rating 与 durable Work completion 产生有界 ranking impact，而普通 recall、turn completion/failure 与 blocked Work 保持 neutral。Feedback 不可用时保留上一份 durable outcome，全量 reconcile 失败后可重试。没有新增物理 retention policy：expiry 保持可见，tombstone 保留历史。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxlongtermmemory--longtermmemory-abstract-seam"></a>

### `ctx.longTermMemory` — `LongTermMemory` (abstract seam)

Service Definition for durable write governance and cross-session recall.

```ts cordis-catalog
/**
 * Prepare one immutable recall observation before a host turn enters the log.
 * @param input - exact scope, host identity, query, and candidate cap.
 * @param signal - cancellation for the active host turn.
 * @returns provider handle and ranked candidates retained until settlement.
 */
abstract prepare(input: PrepareMemoryTurnInput, signal: AbortSignal): Promise<PreparedMemoryTurn>

/**
 * Commit the exact candidates made model-visible by a successful host turn.
 * @param input - prepared observation and admitted candidate identities.
 * @returns after the provider durably settles the prepared turn.
 */
abstract commit(input: CommitMemoryTurnInput): Promise<void>

/**
 * Abort a prepared turn that never reached a successful host settlement.
 * @param input - prepared observation and stable host-owned reason.
 * @returns after the provider durably settles the prepared turn.
 */
abstract abort(input: AbortMemoryTurnInput): Promise<void>

/**
 * Append the first revision of one governed memory.
 * @param input - scoped content, classification, trust, and durable evidence.
 * @param signal - cancellation for the write.
 * @returns the committed current entry.
 */
abstract remember(input: RememberMemoryInput, signal?: AbortSignal): Promise<MemoryEntry>

/**
 * Append a replacement revision without mutating prior evidence.
 * @param input - scoped identity, changed fields, and new evidence.
 * @param signal - cancellation for the write.
 * @returns the committed current entry.
 */
abstract revise(input: ReviseMemoryInput, signal?: AbortSignal): Promise<MemoryEntry>

/**
 * Append a tombstone and remove the entry from recall indexes.
 * @param input - scoped identity, reason, and durable evidence.
 * @param signal - cancellation for the write.
 * @returns the committed tombstoned entry.
 */
abstract forget(input: ForgetMemoryInput, signal?: AbortSignal): Promise<MemoryEntry>

/**
 * Read one current entry inside an exact scope.
 * @param scope - exact recall partition.
 * @param id - logical memory identity.
 * @param signal - cancellation for the read.
 * @returns current entry, or undefined when absent from this scope.
 */
abstract read(scope: MemoryScope, id: MemoryId, signal?: AbortSignal): Promise<MemoryEntry | undefined>

/**
 * List the provider's current materialized entries for one exact scope.
 * Unlike recall search, this governance read can include expired, superseded, and tombstoned
 * entries and never changes retrieval-use accounting.
 * @param input - exact scope, filters, and deterministic page window.
 * @param signal - cancellation for the read.
 * @returns one newest-first page and the matching total.
 */
abstract list(input: ListMemoryInput, signal?: AbortSignal): Promise<MemoryListPage>

/**
 * Find deterministic normalized-key conflicts in one exact scope.
 * @param input - target identity and result cap.
 * @param signal - cancellation for the read.
 * @returns duplicate or summary-collision candidates.
 */
abstract findConflicts( input: FindMemoryConflictsInput, signal?: AbortSignal, ): Promise<readonly MemoryConflictCandidate[]>

/**
 * Read canonical retrieval and user-governance signals.
 * @param scope - exact recall partition.
 * @param id - logical memory identity.
 * @param signal - cancellation for the read.
 * @returns chronological signal history.
 */
abstract listSignals(scope: MemoryScope, id: MemoryId, signal?: AbortSignal): Promise<readonly MemorySignal[]>

/**
 * Atomically replace one Session's reconciler-owned outcome observations.
 * @param input - exact scope, Session, and complete derived outcome set.
 * @param signal - cancellation before the write begins.
 * @returns after the canonical outcome view is durable.
 */
abstract reconcileOutcomes(input: ReconcileMemoryOutcomesInput, signal?: AbortSignal): Promise<void>

/**
 * Read recent outcome observations for one memory.
 * @param input - exact scope, identity, and result cap.
 * @param signal - cancellation for the read.
 * @returns newest-first outcome observations.
 */
abstract listOutcomes(input: ListMemoryOutcomesInput, signal?: AbortSignal): Promise<readonly MemoryOutcome[]>

/**
 * Search current entries inside an exact scope.
 * @param input - normalized query, filters, result cap, and optional access-accounting policy.
 * @param signal - cancellation for the read.
 * @returns ranked current entries with retrieval-channel evidence.
 */
abstract search(input: SearchMemoryInput, signal?: AbortSignal): Promise<readonly MemorySearchHit[]>
```

Source: [`packages/memory/memory/src/index.ts:91`](../../packages/memory/memory/src/index.ts)

<a id="ctxmemoryconflictdetector--memoryconflictdetector-abstract-seam"></a>

### `ctx.memoryConflictDetector` — `MemoryConflictDetector` (abstract seam)

Optional semantic detector composed by deployments that can justify richer conflict candidates.

```ts cordis-catalog
/**
 * Detect provider-attributed semantic conflicts without mutating canonical memory.
 * @param input - target plus bounded same-Scope candidates.
 * @param signal - cancellation for optional provider work.
 * @returns attributed conflict candidates only.
 */
abstract detect( input: DetectMemoryConflictsInput, signal?: AbortSignal, ): Promise<readonly MemoryConflictCandidate[]>
```

Source: [`packages/memory/memory/src/index.ts:73`](../../packages/memory/memory/src/index.ts)

<a id="ctxmemoryextractionqueue--memoryextractionqueue-abstract-seam"></a>

### `ctx.memoryExtractionQueue` — `MemoryExtractionQueue` (abstract seam)

Provider-neutral durable queue used by turn capture and extractor workers.

```ts cordis-catalog
/**
 * Idempotently admit one completed-turn source snapshot.
 * @param input - exact Scope, source hash, route, bounded sources, and retry cap.
 * @returns existing or newly committed job for the dedupe identity.
 */
abstract enqueue(input: EnqueueMemoryExtractionInput): Promise<MemoryExtractionJob>

/**
 * Atomically claim the oldest available job or reclaim one whose lease expired.
 * @param input - worker identity, lease duration, and optional deterministic clock.
 * @returns claimed running job, or undefined when none is available.
 */
abstract claim(input: ClaimMemoryExtractionInput): Promise<MemoryExtractionJob | undefined>

/**
 * Commit one successful extraction under the current lease.
 * @param input - job, worker identity, and terminal result.
 * @returns completed job.
 */
abstract complete(input: CompleteMemoryExtractionInput): Promise<MemoryExtractionJob>

/**
 * Settle one failed attempt as pending retry or terminal failed.
 * @param input - job, worker identity, error, and requested retry time.
 * @returns updated job.
 */
abstract fail(input: FailMemoryExtractionInput): Promise<MemoryExtractionJob>

/**
 * Read one job for diagnostics and tests.
 * @param id - durable job identity.
 * @returns current job, or undefined when absent.
 */
abstract read(id: MemoryExtractionJobId): Promise<MemoryExtractionJob | undefined>
```

Source: [`packages/memory/memory/src/extraction.ts:20`](../../packages/memory/memory/src/extraction.ts)

<a id="ctxmemoryoutcomereconciler--memoryoutcomereconciler"></a>

### `ctx.memoryOutcomeReconciler` — `MemoryOutcomeReconciler`

Host service maintaining idempotent Memory outcome observations from durable Session facts.

```ts cordis-catalog
/**
 * Reconcile the complete live-preferred persisted corpus once per process unless explicitly refreshed.
 * @param refresh - force a new full observation after the initial pass.
 * @returns after every readable Session has settled independently.
 */
ensureReconciled(refresh: boolean = false): Promise<void>

/**
 * Reconcile all logical Sessions through Session Query without resuming an Agent.
 * @returns after the bounded worker pool settles all Sessions.
 */
async reconcileAll(): Promise<void>

/**
 * Reconcile one logical Session through the live-preferred non-activating Session Query read.
 * @param sessionId - logical Session identity.
 * @returns after its complete derived outcome set replaces the previous set.
 */
reconcileSession(sessionId: SessionId): Promise<void>
```

Types: [SessionId](core.md)

Source: [`packages/memory/memory-outcome-reconciler/src/index.ts:58`](../../packages/memory/memory-outcome-reconciler/src/index.ts)
<!-- END GENERATED cordis-surface -->
