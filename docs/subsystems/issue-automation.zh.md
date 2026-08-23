# Issue Automation

[English](issue-automation.md) | 中文

Issue Automation 是可选 Host 子系统，把 Provider-scoped Tracker 队列转成隔离、可观测的 Agent 运行。它不属于 Agent Loop、Workflow、Schedule、Jobs 或 Workspace Registry。[已实现 Agent Note](../../.agents/notes/implemented/feature/2026-08-23-durable-issue-automation.md)拥有该分离和取舍。

## Capability roles

`ctx.trackers` 是具名 Provider Registry。`TrackerProvider` 提供按状态读取候选项、按精确 ID 对账，以及捕获的 `TrackerToolBinding`。`TrackerIssue.id` 是带 brand 的调度身份；`identifier` 是人类可读值并派生目录 key。`dispatchable`、标签、状态和 blocker 都是显式路由事实，而不是 Scheduler 从 Provider payload 猜测的结果。

`ctx.issueWorkflow` 拥有一个不可变策略版本。File Provider 从 YAML front matter 读取 Tracker、polling、concurrency、retry、continuation 和 stall 设置；Markdown 正文是首轮模板。启动要求有效版本；reload 失败保留最后有效 snapshot；活动运行保留发布前捕获的版本与工具 binding。

`ctx.issueWorkspace` 把目录生命周期和 Workspace Registry 的 Session 分组分开。`locate()` 无创建地计算路径；`prepare()` 创建或复用目录并完成一次性设置；`beforeRun()` 阻塞当前 attempt；`afterRun()` 与删除前准备按尽力语义执行。本地 Provider 在创建、hook 和删除前验证 canonical root containment。

`ctx.issueRunner` 发布 holder-owned `IssueRun`。原生 Provider 在准备好的 cwd 创建一个 Agent Session，在未发布 Agent Scope 中注册捕获的 Tracker 工具；只要按精确 ID refresh 后仍可执行，就在有界 continuation 轮次中复用该 Session。结果只在 Agent Scope dispose 后 resolve。

`ctx.issueOrchestration` 是持久 Scheduler 上的 Operator／查询服务。`snapshot()` 分开呈现 running／claimed、retrying、blocked 记录；`refresh()` 合并即时 reconciliation tick；`retry()` 和 `release()` 只接受非运行记录；reconciliation 仍是停止 live work 的常规 Authority。

## Durable scheduling

Issue Orchestrator storage domain 是唯一状态 Owner。Dispatch 先提交 `claimed`，再准备 Workspace 并启动 Runner，最后提交 `running`。失败会提交 `retrying`，包含下一 attempt、due time、Workspace 和有界指数退避错误。需要 Operator 操作的请求提交 `blocked`，不建立 retry timer。Host 启动把中断的 `claimed` 或 `running` row 转成即时重试；不会把未知进程呈现为已恢复。

每次 tick 都 reload 策略、对账 running 与 blocked ID、检查 last-progress 静默、处理到期 retry、读取候选项、按 Provider priority 与时间排序，并在 dispatch 前按精确 ID 重验每个选中项。全局和规范化 per-state capacity 同时计算 claimed 与 running row，因此 Workspace 设置过程不会超额分配。

## Linear Provider and operator UI

首个 Provider 是 Linear。Scheduler 读取保持项目范围和分页；按精确 ID 的读取采用批处理。捕获的 `linear_graphql` 工具在 Host 使用捕获 token 执行，binding 同时声明 token 环境变量别名供 managed child 清理。其原始原生可达范围是有意选择；仓库 Workflow 拥有允许的变更和 Provider 幂等性。

生成的 `issueOrchestration` Remote 暴露 snapshot 与 Operator 命令。可选浏览器插件订阅 `issue-orchestration/changed`、刷新一个 observable snapshot，并贡献标题栏 badge 与 running／retrying／blocked overlay。它不改变 Session 或模型上下文。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxissueorchestration--issueorchestration-abstract-seam"></a>

### `ctx.issueOrchestration` — `IssueOrchestration` (abstract seam)

Operator/query surface over one durable orchestration authority.

```ts cordis-catalog
/**
 * Read current operator state.
 * @returns A detached complete operator snapshot.
 */
abstract snapshot(): IssueOrchestrationSnapshot

/**
 * Request an immediate poll.
 * @returns A receipt saying whether it was coalesced.
 */
abstract refresh(): IssueRefreshResult

/**
 * Retry non-running work.
 * @param command Issue to retry now.
 * @returns After durability.
 */
abstract retry(command: IssueCommand): Promise<void>

/**
 * Release non-running work.
 * @param command Issue claim to release.
 * @returns After durability.
 */
abstract release(command: IssueCommand): Promise<void>
```

Source: [`packages/automation/issue-orchestration/src/index.ts:20`](../../packages/automation/issue-orchestration/src/index.ts)

<a id="ctxissuerunner--issuerunner-abstract-seam"></a>

### `ctx.issueRunner` — `IssueRunner` (abstract seam)

Provider-neutral publisher of holder-owned issue runs.

```ts cordis-catalog
/**
 * Prepare and publish one run, or reject before returning a handle.
 * @param request Captured issue, workspace, policy, tools, and callbacks.
 * @returns The holder-owned published run.
 */
abstract start(request: IssueRunRequest): Promise<IssueRun>
```

Source: [`packages/automation/issue-runner/src/index.ts:18`](../../packages/automation/issue-runner/src/index.ts)

<a id="ctxissueworkflow--issueworkflow-abstract-seam"></a>

### `ctx.issueWorkflow` — `IssueWorkflow` (abstract seam)

Last-known-good workflow provider with explicit reload.

```ts cordis-catalog
/**
 * Read the current workflow.
 * @returns The immutable authoritative revision.
 */
abstract current(): IssueWorkflowSnapshot

/**
 * Re-read the workflow source.
 * @returns True only when a different valid revision commits.
 */
abstract reload(): Promise<boolean>
```

Source: [`packages/automation/issue-workflow/src/index.ts:27`](../../packages/automation/issue-workflow/src/index.ts)

<a id="ctxissueworkspace--issueworkspaceprovisioner-abstract-seam"></a>

### `ctx.issueWorkspace` — `IssueWorkspaceProvisioner` (abstract seam)

Provider-neutral workspace creation, attempt hooks, and terminal cleanup.

```ts cordis-catalog
/**
 * Create or reuse one issue workspace.
 * @param issue Issue to prepare.
 * @param signal Cancellation.
 * @returns Prepared workspace after setup.
 */
abstract prepare(issue: TrackerIssue, signal?: AbortSignal): Promise<IssueWorkspace>

/**
 * Locate without mutation.
 * @param issue Issue to locate.
 * @param signal Cancellation.
 * @returns Deterministic workspace without mutation.
 */
abstract locate(issue: TrackerIssue, signal?: AbortSignal): Promise<IssueWorkspace>

/**
 * Run attempt-blocking setup.
 * @param workspace Prepared workspace.
 * @param issue Owning issue.
 * @param signal Cancellation.
 */
abstract beforeRun(workspace: IssueWorkspace, issue: TrackerIssue, signal?: AbortSignal): Promise<void>

/**
 * Run best-effort attempt cleanup.
 * @param workspace Prepared workspace.
 * @param issue Owning issue.
 */
abstract afterRun(workspace: IssueWorkspace, issue: TrackerIssue): Promise<void>

/**
 * Remove one terminal workspace.
 * @param workspace Prepared workspace.
 * @param issue Owning terminal issue.
 */
abstract remove(workspace: IssueWorkspace, issue: TrackerIssue): Promise<void>
```

Source: [`packages/automation/issue-workspace/src/index.ts:19`](../../packages/automation/issue-workspace/src/index.ts)

<a id="ctxtrackers--trackerregistry"></a>

### `ctx.trackers` — `TrackerRegistry`

Provider-neutral registry with effect-scoped registration and run-scoped tool capture.

```ts cordis-catalog
/**
 * Register a provider.
 * @param provider Provider to own until caller disposal.
 * @returns Exact effect disposer.
 */
register(provider: TrackerProvider): () => void

/**
 * Resolve a provider.
 * @param name Registered provider name.
 * @returns Exact provider or throws.
 */
require(name: string): TrackerProvider

/**
 * List providers.
 * @returns Provider names in registration order.
 */
list(): readonly string[]

/**
 * Capture and validate one provider's exact tool/configuration snapshot.
 * Provider removal blocks later captures but does not revoke a returned binding.
 * @param name Registered provider to capture.
 * @returns Validated immutable tool binding.
 */
bindTools(name: string): TrackerToolBinding
```

Source: [`packages/tracker/tracker/src/index.ts:54`](../../packages/tracker/tracker/src/index.ts)

<a id="issue-orchestration-events"></a>

### `issue-orchestration/*` events

<a id="issue-orchestrationchanged--emit"></a>

#### `issue-orchestration/changed` — emit

Durable orchestration state changed; observers re-read `snapshot()`.

```ts cordis-catalog
/**
 * Durable orchestration state changed; observers re-read `snapshot()`.
 * @param revision Authoritative process-local projection revision.
 * @mode emit
 */
'issue-orchestration/changed'(revision: number): void
```

Source: [`packages/automation/issue-orchestration/src/types.ts:61`](../../packages/automation/issue-orchestration/src/types.ts)

<a id="issue-workflow-events"></a>

### `issue-workflow/*` events

<a id="issue-workflowupdated--emit"></a>

#### `issue-workflow/updated` — emit

A new validated workflow revision became authoritative.

```ts cordis-catalog
/**
 * A new validated workflow revision became authoritative.
 * @param next Newly committed immutable snapshot.
 * @param previous Replaced last-known-good snapshot.
 * @mode emit
 */
'issue-workflow/updated'(next: IssueWorkflowSnapshot, previous: IssueWorkflowSnapshot): void
```

Source: [`packages/automation/issue-workflow/src/index.ts:22`](../../packages/automation/issue-workflow/src/index.ts)

<a id="tracker-events"></a>

### `tracker/*` events

<a id="trackerprovider-added--emit"></a>

#### `tracker/provider-added` — emit

A provider became available after its registry insertion committed.

```ts cordis-catalog
/**
 * A provider became available after its registry insertion committed.
 * @param provider Exact registered provider.
 * @mode emit
 */
'tracker/provider-added'(provider: TrackerProvider): void
```

Source: [`packages/tracker/tracker/src/index.ts:43`](../../packages/tracker/tracker/src/index.ts)

<a id="trackerprovider-removed--emit"></a>

#### `tracker/provider-removed` — emit

A provider was removed before this notification.

```ts cordis-catalog
/**
 * A provider was removed before this notification.
 * @param name Removed provider name.
 * @mode emit
 */
'tracker/provider-removed'(name: string): void
```

Source: [`packages/tracker/tracker/src/index.ts:49`](../../packages/tracker/tracker/src/index.ts)
<!-- END GENERATED cordis-surface -->
