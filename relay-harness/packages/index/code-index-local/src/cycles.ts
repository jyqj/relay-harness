/**
 * Pure answer assembly for the seam's `cycles` explore op: circular
 * dependency detection over the file-import graph via an iterative Tarjan
 * SCC pass. Ported from the reference implementation's `graph_cycles.rs`
 * (file granularity only — the package/community projections stay there).
 *
 * Contracts:
 * - Only components of size > 1 count; a self-import is an SCC of size 1 and
 *   never surfaces as a cycle.
 * - Components order by size descending BEFORE the `max` cap cuts, so
 *   truncation always keeps the largest cycles; equal sizes tie-break on the
 *   sorted member list so the order stays deterministic.
 * - Severity follows the reference's file-granularity classes (`>=5` high,
 *   `>=3` medium, otherwise low); the reference's `critical` class belongs to
 *   its community granularity, which this provider does not project.
 * - Each component carries its witness edges: stored import rows whose both
 *   endpoints are members, deduplicated per `from>to` file pair (parallel
 *   import statements witness one edge, keeping the first import string).
 *
 * @module @relay-harness/rlh-code-index-local/cycles
 */

import type {
  GraphCycleComponentView,
  GraphCycleEdgeView,
  GraphCycleSeverity,
  GraphExploreRequest,
  GraphExploreResult,
} from '@relay-harness/rlh-code-index'
import { compareStrings } from '@relay-harness/rlh-code-index-search'
import { TRUNCATED_RESULT_LIMIT } from './explore.ts'
import type { ExploreGraphInput } from './explore.ts'
import { finishAnswer } from './explore.ts'

/** Declared edge kinds for the `cycles` op: the file-import graph only. */
export const CYCLES_DECLARED: readonly string[] = ['IMPORTS']

/**
 * Component cap when the request carries no `max` — the reference
 * implementation's `circular_deps` output budget at its largest tier.
 */
export const DEFAULT_MAX_CYCLES = 20

/**
 * Iterative Tarjan strongly-connected components over a file-import
 * adjacency, returning ONLY components with more than one member. Node
 * iteration follows the sorted node set and neighbor lists arrive sorted, so
 * the component list is deterministic for a given adjacency.
 * @param adjacency - directed `file → sorted targets` adjacency.
 * @returns the multi-member components in discovery order.
 */
export function tarjanScc(adjacency: ReadonlyMap<string, readonly string[]>): string[][] {
  const nodes = new Set<string>()
  for (const [node, targets] of adjacency) {
    nodes.add(node)
    for (const target of targets) nodes.add(target)
  }

  let counter = 0
  const state = new Map<string, { index: number; lowlink: number; onStack: boolean }>()
  const sccStack: string[] = []
  const components: string[][] = []

  for (const start of [...nodes].sort(compareStrings)) {
    if (state.has(start)) continue
    state.set(start, { index: counter, lowlink: counter, onStack: true })
    counter += 1
    sccStack.push(start)
    // Work frames carry the node plus its next unread neighbor position, so
    // deep import chains never recurse.
    const work: Array<{ node: string; next: number }> = [{ node: start, next: 0 }]
    while (work.length > 0) {
      const frame = work[work.length - 1] as { node: string; next: number }
      const neighbors = adjacency.get(frame.node) ?? []
      if (frame.next < neighbors.length) {
        const target = neighbors[frame.next] as string
        frame.next += 1
        const frameState = state.get(frame.node) as { index: number; lowlink: number; onStack: boolean }
        const targetState = state.get(target)
        if (targetState !== undefined) {
          if (targetState.onStack && targetState.index < frameState.lowlink) frameState.lowlink = targetState.index
        } else {
          state.set(target, { index: counter, lowlink: counter, onStack: true })
          counter += 1
          sccStack.push(target)
          work.push({ node: target, next: 0 })
        }
      } else {
        work.pop()
        const frameState = state.get(frame.node) as { index: number; lowlink: number; onStack: boolean }
        if (frameState.lowlink === frameState.index) {
          const component: string[] = []
          for (;;) {
            const member = sccStack.pop() as string
            const memberState = state.get(member) as { onStack: boolean }
            memberState.onStack = false
            component.push(member)
            if (member === frame.node) break
          }
          if (component.length > 1) components.push(component)
        }
        const parent = work[work.length - 1]
        if (parent !== undefined) {
          const parentState = state.get(parent.node) as { lowlink: number }
          if (frameState.lowlink < parentState.lowlink) parentState.lowlink = frameState.lowlink
        }
      }
    }
  }
  return components
}

/**
 * File-granularity severity class: larger cycles bind more files and rate
 * higher (the reference's `classify_severity("file", size)`).
 * @param size - member count of the component.
 * @returns `high` at 5+ members, `medium` at 3-4, otherwise `low`.
 */
export function cycleSeverity(size: number): GraphCycleSeverity {
  if (size >= 5) return 'high'
  if (size >= 3) return 'medium'
  return 'low'
}

/** Deterministic component order: size descending, ties broken on the sorted member list. */
function compareComponents(left: string[], right: string[]): number {
  return right.length - left.length
    || compareStrings([...left].sort(compareStrings).join(' '), [...right].sort(compareStrings).join(' '))
}

/**
 * Answer the `cycles` op: import-graph components with witnesses, largest
 * first, cut to the requested cap after ordering.
 * @param input - the question, facet, tier limits, tier, and epochs.
 * @param request - the `cycles` request carrying its optional cap.
 * @returns the complete answer; `candidateCount` counts every component found
 *   and `truncated` rides with `result_limit` when the cap cut the list.
 */
export function cyclesAnswer(
  input: ExploreGraphInput,
  request: Extract<GraphExploreRequest, { op: 'cycles' }>,
): GraphExploreResult {
  const cap = request.max ?? DEFAULT_MAX_CYCLES
  const components = tarjanScc(input.facet.fileImportAdjacency())
  const ordered = [...components].sort(compareComponents)
  const cycles: GraphCycleComponentView[] = ordered.slice(0, cap).map((members, position) => {
    const memberIds = [...members].sort(compareStrings)
    // Multiple import statements between the same pair of files are one
    // witness edge: keep the first (lexicographically smallest import string)
    // per `from>to` pair.
    const seenPairs = new Set<string>()
    const witnessEdges: GraphCycleEdgeView[] = input.facet.internalEdgesForUids(memberIds)
      .map(row => ({ from: row.from, to: row.to, importString: row.importString }))
      .sort((left, right) =>
        compareStrings(left.from, right.from) || compareStrings(left.to, right.to) || compareStrings(left.importString, right.importString))
      .filter((edge) => {
        const key = `${edge.from}>${edge.to}`
        if (seenPairs.has(key)) return false
        seenPairs.add(key)
        return true
      })
    return { id: `cycle:${position + 1}`, size: members.length, severity: cycleSeverity(members.length), memberIds, witnessEdges }
  })
  const truncatedReason = components.length > cycles.length ? TRUNCATED_RESULT_LIMIT : undefined
  return {
    ...finishAnswer(input, 'cycles', CYCLES_DECLARED, [], [], undefined, [], truncatedReason, components.length),
    cycles,
  }
}
