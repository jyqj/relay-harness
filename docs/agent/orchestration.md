# Subagent Orchestration

English | [中文](orchestration.zh.md)

## 1. Use principles

Subagents serve well-bounded subtasks with independent context that can run in parallel. Work with strong sequential dependencies, continuous global-state needs, or high-impact decisions stays with the primary agent.

## 2. SubagentSpec

```yaml
subagent_spec:
  id: string
  goal: string
  boundaries: [string]
  acceptance: [string]
  context_refs: [string]
  routing_signal: RoutingSignal
  tool_policy: string
  max_steps: int
```

Requirements:

- `goal / boundaries / acceptance` cannot be empty;
- `context_refs` can reference only content the current Work may access;
- `routing_signal.source` must be `parent_agent`;
- emphasis weights must sum to `1.0`;
- a subagent cannot create another subagent layer.

## 3. Isolation

- A subagent receives only SubagentSpec and a necessary context projection, not the complete parent session.
- File and tool permissions cannot exceed the parent Work.
- Actions requiring user confirmation return to the primary agent rather than asking the user directly.
- A subagent cannot write long-term memory.

## 4. Output contract

```yaml
subagent_result:
  id: string
  status: complete|partial|failed|blocked|cancelled
  summary: string
  artifacts: [ArtifactRef]
  evidence: [EvidenceRef]
  unresolved: [string]
  conflicts: [string]
```

The primary agent validates this contract, merges artifacts, and performs overall local verification. A subagent's completion claim cannot complete the parent Work directly.

## 5. Cancellation and failure

- Cancelling Work broadcasts cancellation to every running subagent.
- One subagent failure does not automatically cancel independent work.
- Classify an error as recoverable, input-required, or unrecoverable before retrying, degrading to `partial`, or returning it to the primary agent.
- Failure does not trigger a “stronger-model cascade”; each call's pre-request signal and scheduling policy continue to own model selection.
