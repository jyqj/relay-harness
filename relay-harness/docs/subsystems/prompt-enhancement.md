# Prompt Enhancement

English | [中文](prompt-enhancement.zh.md)

Prompt Enhancement improves an unsent draft through a separate, cancellable model request. The Host service owns one Context Engine adapter and one enhancement provider; the Web client owns initiation, compare-before-replace, and undo. No path submits the draft or enters AgentLoop.

Sources: [`packages/context/prompt-enhancement/src/index.ts`](../../packages/context/prompt-enhancement/src/index.ts) · [`packages/context/prompt-enhancement-llm/src/index.ts`](../../packages/context/prompt-enhancement-llm/src/index.ts) · [`packages/context/prompt-enhancement-context-engine/src/index.ts`](../../packages/context/prompt-enhancement-context-engine/src/index.ts) · [`packages/client/ui-prompt-enhancement/src/client/index.ts`](../../packages/client/ui-prompt-enhancement/src/client/index.ts)

## Shared context

The Context Engine adapter passes `purpose: 'prompt_enhancement'`, the exact draft as claimed input, detached caller/session/workspace metadata, and cancellation to the same `ctx.contextEngine.prepareStep()` used for ordinary Agent steps. It returns the engine's selected messages and projects existing contribution, Evidence, and coverage values into an opaque JSON trace. The Prompt Enhancement service neither understands that trace nor recollects any source.

The shipped Web composition uses this adapter. The base layer also composes `session-history-context`, which contributes only for Prompt Enhancement and selects completed direct-user/model exchanges plus approved compaction checkpoints from the caller's durable Session surface. It excludes recalls, injected context, tools, unsuccessful turns, and unapproved checkpoints to prevent recursion. `prompt-enhancement-context-none` is an explicit test or deployment choice and is never a missing-engine fallback.

## Auxiliary request and result

The LLM provider sends the prepared messages followed by one JSON-framed draft under a stable instruction. `GenerateOptions.tools` is absent and the call executes through `ctx.llm`, not AgentLoop or the tool runtime. A pre-dispatch `prompt-enhancement/llm-request` event records the exact purpose and every model-visible field without adding them to derived conversation history.

The complete request and incremental raw output stream are byte-bounded. The provider accepts JSON with exactly `enhancedDraft`, `assumptions`, and `openQuestions`. The service adds the exact original draft, model provenance, and optional Context Engine trace. Cancellation, provider failure, missing composition, malformed output, and timeouts return `kind: 'preserved'` with the exact original draft.

## Browser lifecycle

The `conversation.input.right` control starts one cancellable request. A successful result opens an Original/Enhanced diff with assumptions and open questions; only explicit Accept replaces the draft, and only if the current value and `draftRev` still equal the captured attempt. The ordinary input transaction records the replacement; both composer undo and the explicit Undo action restore the original under a second CAS. The busy control cancels over the generated Remote, while Cancel, failure, mismatched output, session switch/removal, and unmount leave the draft untouched. No branch submits.

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
