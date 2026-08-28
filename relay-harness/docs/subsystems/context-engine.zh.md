# Context Engine

[English](context-engine.md) | 中文

本地上下文引擎 seam：一个步骤上下文 contributor 注册表，AgentLoop 在 inbox 领取与提示词组装之间查询它；外加 contributor 与知识 Provider 适配器之间交换的证据、覆盖与可观测性词汇。设计权威位于 Relay 根仓库（`docs/adr/0006-local-context-engine.md`（ADR-0006）与 `docs/agent/context-engine.md`）；本页投影 harness 侧契约。

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

`ContextEngineService.registerContributor` 原子保留唯一 contributor id；`prepareStep` 按注册顺序、每个已领取步骤一次地运行全部 contributor，输入为已领取消息、步骤中止信号与会话 header 工作目录。贡献的消息追加进步骤的 user 消息并落为持久 `user/message` 事件；无贡献的步骤与未部署该服务的部署逐字节一致。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcontextengine--contextengineservice"></a>

### `ctx.contextEngine` — `ContextEngineService`

`ctx.contextEngine`. Owns the contributor registry and the step preparation call; retrieval planning, hydration, and packing enrich `prepareStep` inside implementations of this seam.

```ts cordis-catalog
/**
 * Register one step-context contributor.
 * @param contributor - the contributor with a unique non-empty id.
 * @returns a disposer removing the registration.
 */
registerContributor(contributor: StepContextContributor): () => void

/**
 * Prepare the step context for one claimed step.
 * @param input - the claimed messages and abort signal.
 * @returns the collected context, or `undefined` when no contributor produced any.
 */
prepareStep(input: StepContextInput): Promise<PreparedStepContext | undefined>
```

Source: [`packages/context/context-engine/src/types.ts:203`](../../packages/context/context-engine/src/types.ts)
<!-- END GENERATED cordis-surface -->
