# Context Engine

[English](context-engine.md) | 中文

本地上下文引擎 seam：一个供 AgentLoop 与 Prompt Enhancement 使用、带 purpose 的上下文 contributor 注册表；外加 contributor 与知识 Provider 适配器之间交换的证据、覆盖与可观测性词汇。设计权威位于 Relay 根仓库（`docs/adr/0006-local-context-engine.md`（ADR-0006）与 `docs/agent/context-engine.md`）；本页投影 harness 侧契约。

Sources: [`packages/context/context-engine/src/types.ts`](../../packages/context/context-engine/src/types.ts) · [`packages/context/context-engine/src/index.ts`](../../packages/context/context-engine/src/index.ts)

## 资源寻址与证据

`ResourceRef` 以 source id、不透明的 source 局部 key 与 revision 寻址一个资源。revision 对引擎不透明：文件树用 stat 身份，会话语料库用事件 seq，记忆作用域用版本号。省略 revision 表示显式未知，绝不是"任意版本"。

`Evidence` 是绑定该 revision 的一条已准入观察，带可选内容摘要、截断标志、新鲜度与验证结果。`unverified` 是显式状态而非默认值：机械验证（摘要与 revision 一致性）是准入时检查，语义验证只在显式义务下运行。

```ts type-equiv
/**
 * One addressable resource inside a registered source. `key` and `revision` are opaque to the
 * engine: a file tree uses paths and stat identities, a session corpus uses ids and event seqs,
 * a memory scope uses entry ids and revision numbers.
 */
interface ResourceRef {
  /** The source that owns and addresses the resource. */
  readonly sourceId: SourceId
  /** Source-local opaque resource key (never a bare cross-source path). */
  readonly key: string
  /** Source-local opaque revision; omitted marks `revision unknown`, never "any revision". */
  readonly revision?: string
}
```

## 检索覆盖与否定发现

`CoverageRecord` 记录一次检索实际检查了什么：搜索过的范围、刻意跳过的范围及原因、完备性分级。`NegativeFinding` 携带一条否定断言与支持它检查过的范围；空的 `checked` 列表无效，因为没有检查范围的否定断言不可主张。

```ts type-equiv
/**
 * What a retrieval actually inspected: the scopes searched, the scopes deliberately skipped and
 * why, and the completeness classification. A zero-hit result without a coverage record reads as
 * "not found here", never as "does not exist".
 */
interface CoverageRecord {
  /** Scopes actually inspected (directories, sources, patterns), as specific as available. */
  readonly searched: readonly string[]
  /** Scopes a consumer might expect to be covered but were deliberately skipped. */
  readonly notSearched: readonly string[]
  /** One-sentence justification of the searched/not-searched split. */
  readonly rationale?: string
  /** Completeness classification of the inspection. */
  readonly completeness: CoverageCompleteness
}
```

## Provider 可观测性

`ProviderHealthState`、`ProviderGeneration` 与 `ProviderExplain` 是知识 Provider 适配器报告的健康与降级面。代际对是双时钟缓存键——索引内容提交推进 `indexEpoch`，仅运行时证据摄取推进 `evidenceEpoch`——而 `ProviderExplain.truncatedReason` 是稳定 token（`output_budget`、`default_limit`、`max_depth`、`db_error:<op>` 等），绝不是自由文本，消费方可对其断言。

```ts type-equiv
/**
 * Two-clock generation of one knowledge provider's index: `indexEpoch` advances on index-content
 * commits, `evidenceEpoch` only on runtime-evidence ingestion, so evidence writes do not
 * invalidate index-only caches. Consumers compare the pair as a cache key.
 */
interface ProviderGeneration {
  /** Generation of index content (file batches, graph rebuilds, full rebuilds). */
  readonly indexEpoch: number
  /** Generation of runtime-evidence ingestion alone. */
  readonly evidenceEpoch: number
}
```

## 步骤上下文 seam

`ContextEngineService.registerContributor` 原子保留唯一 contributor id。`prepareStep` 根据请求 purpose 与每个 contributor 声明的 purposes 解析确定性 plan，分配局部字符／token／deadline 配额，再以隔离的子 abort signal 在整次准备 deadline 内有界并发运行合格 Provider，排队等待也计入期限。显式引用候选优先于 Provider 发现的 recall 参与去重和总预算选择；选中消息返回注册顺序。`StepContextCaller` 提供 session／Agent／workspace identity、可选 owning turn／step、有效 preset 与 origin，而不会暴露 live Agent object。发布前，引擎会脱离、无损 JSON 校验并冻结 Provider 自有 contribution。父 abort 原子失败；timeout 或已释放注册代际会忽略迟到结果并继续后续 Provider。Provider 保留检索与 hydration policy；引擎拥有资格、预算、打包与决策 trace。

`ContextProviderError` 把 Provider 的显式 declined、degraded 或 error 分类转换为拒绝 trace，不包含 query 或异常原文；未知 Provider 异常使用 `error/provider_failed`，内部 `ContextEngineError` 与非法 contribution 仍原子失败。注册释放立即取消该代际；引擎卸载等同整次准备取消。

## 持久准备 trace

AgentLoop 拥有获准步骤，因此也拥有持久化：它在追加经准入的 `user/message` 事件之后、分派模型请求之前，追加一条仅存在于日志的 `context/prepared` 事件。事件保留 plan、选中／拒绝 decisions，以及每个选中 contribution 的 Evidence、可选 Coverage、拟议消息 id 和结构精确的准入消息 seq。仅含拒绝的 trace 会记录 timeout、释放、重复或预算结果，而不添加模型可见内容。invariant 要求链接位于精确开放步骤内，并拒绝空且无说明或过晚的 trace。`Evidence.domain` 为 `JsonValue`；ContextEngine 会在准入前校验它，`Session.append` 仍是最终持久边界。trace 不包含消息内容副本，也绝不参与 `deriveMessages()`。

```ts type-equiv
/**
 * One durable context-preparation fact, appended by AgentLoop after the accepted step's messages
 * and before its model request. Messages remain reconstructable from `user/message`; this record
 * carries attribution, evidence, coverage, and admission links without becoming a second transcript.
 */
interface ContextPreparedEventData {
  /** Owning turn. */
  readonly turn: number
  /** Owning step. */
  readonly step: number
  /** Prepared contributions in registry order. */
  readonly contributions: readonly ContextPreparedContributionTrace[]
  /** Deterministic provider eligibility and budget plan. */
  readonly plan: ContextRetrievalPlan
  /** Selected and rejected packing outcomes. */
  readonly decisions: readonly ContextCandidateDecision[]
}
```


## Context Inspector 产品界面

`contextInspector` Session Projection 折叠完整 durable log，而非浏览器分页窗口。它保留最近 50 条 `context/prepared` trace，并把每个 contributor 关联到准确进入模型的 `user/message` seq；空链接继续显示为未采纳或被改写 proposal。证据 source/path/revision、freshness、verification、truncation、provider why-used、searched/not-searched scope、rationale 与 completeness 经标准 projection 通道进入浏览器 drawer。Additive 会话头部 utility 打开抽屉，不改变 Chat node 或模型可见消息。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcontextengine--contextengineservice"></a>

### `ctx.contextEngine` — `ContextEngineService`

`ctx.contextEngine`. Owns contributor registration, deterministic planning, and packing.

```ts cordis-catalog
/**
 * Register one step-context contributor.
 * @param contributor - the contributor with a unique non-empty id.
 * @returns a disposer removing the registration.
 */
registerContributor(contributor: StepContextContributor): () => void

/**
 * Prepare context for one purpose-tagged request.
 * @param input - purpose, messages, parent abort signal, working directory, and caller identity.
 * @returns selected context and its decision trace, or `undefined` when every provider declines.
 */
prepareStep(input: ContextPrepareInput): Promise<PreparedStepContext | undefined>
```

Source: [`packages/context/context-engine/src/types.ts:386`](../../packages/context/context-engine/src/types.ts)

<a id="ctxsessionhistorycontext--sessionhistorycontext"></a>

### `ctx.sessionHistoryContext` — `SessionHistoryContext`

Host service that owns the contributor registration and resolved policy.

Source: [`packages/context/session-history-context/src/index.ts:94`](../../packages/context/session-history-context/src/index.ts)
<!-- END GENERATED cordis-surface -->
