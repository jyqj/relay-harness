/**
 * Package-private bridge from Code Mode to its outer request snapshot.
 * @module @deepseek-ai/dsh-tools/request-snapshot
 */

import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type {
  ToolExecution,
  ToolExecutionInput,
  ToolExecutionMode,
  ToolRuntime,
  ToolRuntimeScheduler,
} from './index.ts'

/** Request-bound capabilities consumed only by the run_code implementation. */
export interface ToolRuntimeExecutionRequest {
  schemas(exec: ToolExecution): ToolSchema[]
  scheduler(exec: ToolExecution): ToolRuntimeScheduler
  executionMode(exec: ToolExecution, input: ToolExecutionInput): ToolExecutionMode
}

const executionRequests = new WeakMap<ToolRuntime, ToolRuntimeExecutionRequest>()

/**
 * Install the private Code Mode bridge for one registry instance.
 * @param runtime - registry instance used as the private lookup key.
 * @param request - request-bound capabilities for that registry.
 */
export function installToolRuntimeExecutionRequest(
  runtime: ToolRuntime,
  request: ToolRuntimeExecutionRequest,
): void {
  executionRequests.set(runtime, request)
}

/**
 * Require the private Code Mode bridge for one initialized registry.
 * @param runtime - initialized registry that owns the bridge.
 * @returns its request-bound Code Mode capabilities.
 */
export function toolRuntimeExecutionRequest(runtime: ToolRuntime): ToolRuntimeExecutionRequest {
  const request = executionRequests.get(runtime)
  /* v8 ignore next -- ToolRuntime installs this bridge during construction before run_code exists. */
  if (request === undefined) throw new Error('tool runtime request bridge is unavailable')
  return request
}
