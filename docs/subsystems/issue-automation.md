# Issue automation

English | [中文](issue-automation.zh.md)

Issue automation is an optional Host subsystem that turns a provider-scoped tracker queue into isolated, observable Agent runs. It is not part of the Agent Loop, Workflow, Schedule, Jobs, or Workspace Registry. The [implemented Agent Note](../../.agents/notes/implemented/feature/2026-08-23-durable-issue-automation.md) owns the separation and trade-offs.

## Capability roles

`ctx.trackers` is the named Provider Registry. A `TrackerProvider` supplies candidate reads by state, exact-id reads for reconciliation, and a captured `TrackerToolBinding`. `TrackerIssue.id` is the branded scheduling identity; `identifier` is human-readable and derives the directory key. `dispatchable`, labels, state, and blockers are explicit routing facts rather than scheduler inference from provider payloads.

`ctx.issueWorkflow` owns one immutable policy revision. The file provider reads YAML front matter for tracker, polling, concurrency, retry, continuation, and stall settings; the Markdown body is the first-turn template. Startup requires a valid revision. Reload failures retain the last valid snapshot, and active runs retain the revision and tool binding captured before publication.

`ctx.issueWorkspace` separates directory lifecycle from the Workspace Registry's Session grouping. `locate()` computes a path without creating it; `prepare()` creates or reuses it and completes one-time setup; `beforeRun()` blocks the attempt; `afterRun()` and removal preparation are best effort. The local provider validates canonical root containment before creation, hooks, and removal.

`ctx.issueRunner` publishes one holder-owned `IssueRun`. The native Provider creates one Agent Session at the prepared cwd, registers the captured tracker tools in the unpublished Agent scope, and reuses that Session for bounded continuation turns while an exact-id refresh remains eligible. Its result resolves only after the Agent scope is disposed.

`ctx.issueOrchestration` is the operator/query service over the durable scheduler. `snapshot()` separates running/claimed, retrying, and blocked records. `refresh()` coalesces an immediate reconciliation tick. `retry()` and `release()` accept only non-running records; reconciliation remains the ordinary stop authority for live work.

## Durable scheduling

The issue-orchestrator storage domain is the single state owner. Dispatch first commits `claimed`, then prepares the workspace and starts the runner, then commits `running`. A failure commits `retrying` with the next attempt, due time, workspace, and bounded exponential-backoff error. A request that needs operator action commits `blocked` without a retry timer. Host startup converts interrupted `claimed` or `running` rows into immediate retries; it never presents an unknown process as resumed.

Every tick reloads policy, reconciles running and blocked ids, checks last-progress silence, processes due retries, fetches candidates, sorts by provider priority and age, and revalidates each selected candidate by exact id before dispatch. Global and normalized per-state capacity count both claimed and running rows, so workspace setup cannot oversubscribe the limit.

## Linear Provider and operator UI

The first Provider is Linear. Scheduler reads stay project-scoped and paginated; exact-id reads are batched. The captured `linear_graphql` tool executes on the Host with the captured token, while the binding declares token environment aliases for managed-child scrubbing. Its raw native reach is intentional; the repository Workflow owns allowed mutations and provider idempotency.

The generated `issueOrchestration` Remote exposes snapshot and operator commands. The optional browser plugin subscribes to `issue-orchestration/changed`, refreshes one observable snapshot, and contributes a titlebar badge plus a running/retrying/blocked overlay. It changes no Session or model context.

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
