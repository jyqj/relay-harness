# Prompt Enhancement

[English](prompt-enhancement.md) | 中文

Prompt Enhancement 通过独立、可取消的模型请求改善未提交草稿。Host 服务拥有一个 Context Engine 适配器和一个增强提供方；Web 客户端拥有发起、Context Evidence 解释、替换前比较与撤销。建议在 Simple 和 Developer 模式下都会展示已接纳的文件、代码、Memory、History 与 MCP Evidence，以及其资源、provider 选择原因、新鲜度和验证状态。任何路径都不会提交草稿或进入 AgentLoop。

来源：[`packages/context/prompt-enhancement/src/index.ts`](../../packages/context/prompt-enhancement/src/index.ts) · [`packages/context/prompt-enhancement-llm/src/index.ts`](../../packages/context/prompt-enhancement-llm/src/index.ts) · [`packages/context/prompt-enhancement-context-engine/src/index.ts`](../../packages/context/prompt-enhancement-context-engine/src/index.ts) · [`packages/client/ui-prompt-enhancement/src/client/index.ts`](../../packages/client/ui-prompt-enhancement/src/client/index.ts)

## 共享上下文

Context Engine 适配器把 `purpose: 'prompt_enhancement'`、作为 claimed input 的精确草稿、分离后的 caller／Session／工作区元数据和取消信号传给普通 Agent step 同样使用的 `ctx.contextEngine.prepareStep()`。它返回引擎选择的消息，并把既有 contribution、Evidence 和 coverage 值投影为不透明 JSON trace。Prompt Enhancement 服务既不理解该 trace，也不会重新收集任何来源。

已发布 Web 组合使用该适配器。Base 层还组合了 `session-history-context`；它只为 Prompt Enhancement contribution，从 caller 的持久 Session surface 选择已完成的直接用户／模型 exchange 与已批准 compaction checkpoint。它排除 recall、注入上下文、工具、未成功 turn 和未批准 checkpoint，防止递归。`prompt-enhancement-context-none` 只是一项显式测试或部署选择，绝不作为引擎缺失时的回退。

## 辅助请求与结果

LLM 提供方在稳定指令下发送已准备消息，随后发送一条 JSON framing 的草稿。`GenerateOptions.tools` 缺失，调用经过 `ctx.llm`，而非 AgentLoop 或工具运行时。Dispatch 前的 `prompt-enhancement/llm-request` 事件记录精确 purpose 和所有模型可见字段，但不把它们加入派生对话历史。

完整请求与增量原始输出流都有字节门禁。提供方只接受恰好包含 `enhancedDraft`、`assumptions` 和 `openQuestions` 的 JSON。服务增加精确原草稿、模型来源和可选 Context Engine trace。取消、提供方失败、组合缺失、格式错误输出和超时都会返回携带精确原草稿的 `kind: 'preserved'`。

## 浏览器生命周期

`conversation.input.right` 控件启动一次可取消请求。成功结果会打开带 assumptions 和 open questions 的原文/增强 diff；只有显式 Accept 且当前值与 `draftRev` 仍等于尝试快照时才替换草稿。普通输入事务记录替换；composer 撤销和显式“撤销增强”都会在第二次 CAS 下恢复原文。忙碌控件通过生成的 Remote 取消请求；Cancel、失败、结果不匹配、Session 切换／移除和卸载都保持草稿不变。任何分支都不会提交。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxpromptenhancement--promptenhancementservice"></a>

### `ctx.promptEnhancement` — `PromptEnhancementService`

Host Prompt Enhancement runtime and generated Remote namespace owner.

```ts cordis-catalog
/**
 * Register the sole enhancement implementation. Its disposer aborts and
 * drains every attempt that captured this registration before releasing it.
 * @param provider - stable identity and side-effect-free enhancement function.
 * @returns awaitable effect disposer.
 */
registerProvider(provider: PromptEnhancementProvider): () => Promise<void>

/**
 * Register the sole adapter from the shared Context Engine. The service does
 * not collect history, files, memory, or Evidence itself.
 * @param provider - Context Engine adapter or explicit draft-only provider.
 * @returns awaitable effect disposer.
 */
registerContextProvider(provider: PromptEnhancementContextProvider): () => Promise<void>

/**
 * Prepare shared context and produce one proposal. Provider errors and every
 * cancellation return a preserved outcome containing the exact original
 * draft; this operation never submits or mutates Agent state.
 * @param agent - target Agent whose scoped context and route are used.
 * @param draft - exact unsent draft.
 * @param signal - caller cancellation.
 * @returns structured proposal or a failure-preserving outcome.
 */
@Remote('enhance') async enhance( agent: Agent, draft: string, signal: AbortSignal, ): Promise<PromptEnhancementOutcome>
```

Types: [Agent](core.md)

Source: [`packages/context/prompt-enhancement/src/index.ts:152`](../../packages/context/prompt-enhancement/src/index.ts)
<!-- END GENERATED cordis-surface -->
