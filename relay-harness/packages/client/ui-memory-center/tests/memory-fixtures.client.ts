/** Complete Memory Center DTOs shared by component and registration tests. */
import type { MemoryCenterDetail, MemoryCenterSnapshot } from '@relay-harness/rlh-api-remotes/client'

export function memory(status: 'candidate' | 'active' | 'tombstoned' = 'candidate'): MemoryCenterDetail {
  return {
    memory: {
      freshness: 'current',
      whyUsed: [{ sessionId: 'session', turn: 2, step: 1, eventSeq: 9, eventTime: 10, evidenceId: 'memory:m1:1', memoryRevision: 1, revisionState: 'current' }],
      entry: {
        id: 'm1' as never,
        revision: 1,
        scope: { workspaceId: '/work', userId: 'user', agentId: 'agent' },
        kind: 'preference',
        status,
        trust: status === 'active' ? 'user-stated' : 'agent-proposed',
        content: 'Always show context provenance.',
        summary: 'Show provenance',
        importance: 3,
        confidence: 0.8,
        createdAt: 1,
        updatedAt: 2,
        evidence: [{
          sessionId: 'session' as never,
          eventSeqs: [4],
          verification: 'agent-proposal',
          excerpt: 'show context provenance',
        }],
        accessCount: 1,
        usefulAccessCount: 2,
      },
    },
    conflicts: [],
    signals: [{
      id: 'signal-1', memoryId: 'm1' as never, kind: 'injected', sessionId: 'session' as never,
      turn: 2, eventSeqs: [], createdAt: 10,
    }],
    outcomes: [{
      id: 'outcome-1', memoryId: 'm1' as never,
      scope: { workspaceId: '/work', userId: 'user', agentId: 'agent' },
      sessionId: 'session' as never, turn: 2, kind: 'assistant-positive', impact: 'positive',
      sourceEventSeqs: [9, 10], observedAt: 11,
    }],
    outcomeSummary: { positive: 1, negative: 0, neutral: 0, rankingAdjustment: 0.025 },
    outcomeCoverage: 'complete',
    usageCoverage: { status: 'complete', sessionsScanned: 2, sessionsFailed: 0 },
  }
}

export function snapshot(detail = memory()): MemoryCenterSnapshot {
  return {
    scope: detail.memory.entry.scope,
    entries: [detail.memory],
    total: 1,
    offset: 0,
    hasMore: false,
    usageCoverage: { status: 'complete', sessionsScanned: 2, sessionsFailed: 0 },
  }
}
