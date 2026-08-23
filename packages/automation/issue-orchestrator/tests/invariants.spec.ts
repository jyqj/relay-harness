import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants'
import TrackerRegistry, { TrackerIssueId, type TrackerProvider } from '@deepseek-ai/dsh-tracker'
import { IssueOrchestration, type IssueCommand, type IssueOrchestrationSnapshot } from '@deepseek-ai/dsh-issue-orchestration'
import type { IssueRefreshResult } from '@deepseek-ai/dsh-issue-orchestration'
import * as TrackerInvariant from '../../../tracker/tracker/src/invariant.ts'
import * as TrackerLinearInvariant from '../../../tracker/tracker-linear/src/invariant.ts'
import * as IssueWorkspaceInvariant from '../../issue-workspace/src/invariant.ts'
import * as IssueWorkspaceLocalInvariant from '../../issue-workspace-local/src/invariant.ts'
import * as IssueRunnerInvariant from '../../issue-runner/src/invariant.ts'
import * as IssueRunnerAgentInvariant from '../../issue-runner-agent/src/invariant.ts'
import * as IssueWorkflowInvariant from '../../issue-workflow/src/invariant.ts'
import * as IssueWorkflowFileInvariant from '../../issue-workflow-file/src/invariant.ts'
import * as IssueOrchestrationInvariant from '../../issue-orchestration/src/invariant.ts'
import * as IssueOrchestratorInvariant from '../src/invariant.ts'

class FakeIssueOrchestration extends IssueOrchestration {
  revision = 1
  snapshot(): IssueOrchestrationSnapshot {
    return {
      revision: this.revision, workflowRevision: 'workflow', checking: false,
      running: [], retrying: [], blocked: [],
    }
  }
  refresh(): IssueRefreshResult { return { queued: true, coalesced: false, requestedAt: 1 } }
  retry(_command: IssueCommand): Promise<void> { return Promise.resolve() }
  release(_command: IssueCommand): Promise<void> { return Promise.resolve() }
}

const provider: TrackerProvider = {
  name: 'memory',
  fetchIssuesByStates: () => Promise.resolve([]),
  fetchIssuesByIds: () => Promise.resolve([]),
  bindTools: () => ({
    provider: 'memory', tools: [], secretEnvironmentNames: [],
    execute: () => Promise.resolve({ success: false, value: null }),
  }),
}

describe('issue automation invariant companions', () => {
  it('registers every companion and checks the three runtime relationships', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(TrackerRegistry)
    await ctx.plugin(FakeIssueOrchestration)
    let workflowRevision = 'next'
    ctx.provide('issueWorkflow', { current: () => ({ revision: workflowRevision }) } as never)

    for (const companion of [
      TrackerInvariant, TrackerLinearInvariant,
      IssueWorkspaceInvariant, IssueWorkspaceLocalInvariant,
      IssueRunnerInvariant, IssueRunnerAgentInvariant,
      IssueWorkflowInvariant, IssueWorkflowFileInvariant,
      IssueOrchestrationInvariant, IssueOrchestratorInvariant,
    ]) await ctx.plugin(companion)

    const dispose = ctx.trackers.register(provider)
    dispose()
    expect(() => { ctx.emit('tracker/provider-added', provider) }).toThrow(InvariantError)
    ctx.trackers.register(provider)
    expect(() => { ctx.emit('tracker/provider-removed', 'memory') }).toThrow(InvariantError)

    const orchestration = ctx.issueOrchestration as FakeIssueOrchestration
    ctx.emit('issue-orchestration/changed', 1)
    expect(() => { ctx.emit('issue-orchestration/changed', 2) }).toThrow(InvariantError)

    const previous = { path: '/workflow', revision: 'old', loadedAt: 1, policy: {} as never }
    const next = { ...previous, revision: 'next' }
    ctx.emit('issue-workflow/updated', next, previous)
    expect(() => { ctx.emit('issue-workflow/updated', previous, previous) }).toThrow(InvariantError)
    workflowRevision = 'other'
    expect(() => { ctx.emit('issue-workflow/updated', next, previous) }).toThrow(InvariantError)
    orchestration.revision = 2
    ctx.emit('issue-orchestration/changed', 2)

    expect(TrackerIssueId('id')).toBe('id')
    await ctx.fiber.dispose()
  })
})
