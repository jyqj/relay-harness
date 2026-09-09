/** Execution-time capture of declared root-call file mutations. */
import type { ToolCallView } from './presentation.ts'

/**
 * Capture file paths from a successful tool's call presenter without failing its completed execution.
 * @param present - captured tool definition's pure call presenter, when declared.
 * @param args - validated arguments used for the execution.
 * @returns first-seen mutation paths; undefined when the presenter failed, empty for a non-mutation intent.
 */
export function captureProducedFiles(
  present: ((args: unknown) => ToolCallView | undefined) | undefined,
  args: unknown,
): readonly string[] | undefined {
  let view: ToolCallView | undefined
  try {
    view = present?.(args)
  } catch {
    // A failed optional presenter cannot turn an already-successful mutation into a retryable tool failure.
    return undefined
  }
  if (view?.card !== 'diff' && !(view?.card === 'generic' && view.kind === 'edit')) return []
  return [...new Set((view.locations ?? []).map(location => location.path))]
}
