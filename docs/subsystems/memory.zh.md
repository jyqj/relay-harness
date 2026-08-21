# 长期记忆

[English](memory.md) | 中文

长期记忆在多个 Agent 会话之间保存受治理的知识，但不替代产生知识的追加式 SessionEvent 证据。[`@deepseek-ai/dsh-memory`](../../packages/memory/memory) 负责 Provider 无关类型与 `ctx.longTermMemory`；[`memory-sqlite`](../../packages/memory/memory-sqlite) 是随附的本地 Provider；[`memory-agent`](../../packages/memory/memory-agent) 与 [`tool-memory`](../../packages/memory/tool-memory) 是相互独立的 Consumer。

## Scope 与标识

每个操作都提供精确的 `MemoryScope`：工作区、用户和稳定 Agent 标识。Session id 是证据和轮次结算标识，不是长期 Scope；相同 Scope 的会话可以互相召回。标准 preset 从会话 cwd 派生工作区，使用本地操作系统用户名，并把 Agent id 固定为 `deepseek-harness`。

`MemoryId` 标识一条逻辑记忆。id 保持稳定，`revision` 递增。Provider 保留每个完整版本，并独立物化当前条目及其召回索引。

## Kind、状态与信任

Kind 区分偏好、事实、约束、决策、流程和教训。项目与用户身份属于 Scope，而不是 kind；实时任务状态留在记忆之外。

状态为 `candidate`、`active`、`disputed`、`superseded` 或 `tombstoned`。主动召回只读取未过期 active 条目。Active 条目要求 `user-stated` 或 `action-verified` 信任，并带有匹配的持久证据。Agent proposal 和外部观察保持 candidate 或 disputed，直到其他可信 Consumer 审核。

## 证据与版本

每次写入都会引用一个 Session id 和非空的早期 event seq。用户陈述证据指向直接用户消息；行动验证证据指向成功工具结果及其调用。新版本绝不替换或删除前置版本。遗忘会追加 tombstone，并从 FTS 移除当前条目，同时保留按精确 id 的审计读取。

模型工具要求精确证据引文后才会请求 active 状态；Provider 会重复执行 trust／evidence 与 secret 检查，因此其他 Consumer 不能绕过该决策。

## 召回生命周期

Agent Consumer 在第一个 `agent/pre-step` 准备候选，此时下游监听器已经接受直接消息。它把保留条目序列化为不受信任 JSON，并放入一条具有独立来源的 `user/message`，因此 Session 日志能重建精确模型请求。完整消息受字符上限约束。Provider 失败采用 fail-open，不修改直接提示。

Prepared handle 保持打开，直到最终 `turn/end`。Completed 与 max-token 轮次提交实际进入模型请求的精确 id；error、abort、interruption、缺少 Assistant 输出、替换或卸载都会执行 abort。SQLite Provider 幂等保存结算，并记录 candidate-hit 和 injected 信号。

Recall-form 用户消息保留在原始 Session 日志中，但不会生成 Session Query 语义文档。这会阻止已召回记忆或被引用 Session 快照变成新的 episodic 证据并递归放大自身。

## SQLite 检索

本地 Provider 为当前非 tombstoned 条目维护 Unicode 与 trigram FTS5 索引。它融合各渠道排名，再应用有界 importance 和 trust 权重。查询和每个元数据筛选器都是 SQL 参数；调用者 Scope 为必填。规范数据库会拒绝无关文件和未知 schema 版本，而不是重置它们。

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
 * Search current entries inside an exact scope.
 * @param input - normalized query, filters, and result cap.
 * @param signal - cancellation for the read.
 * @returns ranked current entries with retrieval-channel evidence.
 */
abstract search(input: SearchMemoryInput, signal?: AbortSignal): Promise<readonly MemorySearchHit[]>
```

Source: [`packages/memory/memory/src/index.ts:51`](../../packages/memory/memory/src/index.ts)
<!-- END GENERATED cordis-surface -->
