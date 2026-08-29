# Agent Runtime

English | [中文](agent-runtime.zh.md)

## 1. Agent loop

Work uses a fixed loop:

```text
understand  读取用户目标、当前对话与显式 File Context
plan        形成可执行步骤和每步验收条件
act         调用工具、Skill 或创建 Subagent
observe     读取结构化结果并更新 Work State
verify      本地确认预期效果是否成立
decide      继续、请求最小输入、部分交付、失败或完成
```

Hard rules:

1. Each turn advances state or states a concrete blocking reason.
2. A successful tool call cannot mark the task complete by itself.
3. High-impact actions pass through a permission gate.
4. The runtime attempts technical recovery internally rather than exposing raw stacks to ordinary users.
5. Verification results enter local Work State only and are not sent to scheduling.

## 2. Terminal states

```text
complete   验收条件全部满足
partial    已有可交付结果，但部分目标未完成
failed     已尝试合理恢复，仍无法完成
blocked    缺少用户输入、权限或外部条件
cancelled  用户取消
```

`blocked` can resume; the other values terminate one Run. A user goal change creates a new Run while preserving the same Work context.

## 3. Work State

```yaml
work_state:
  work_id: string
  run_id: string
  goal: string
  status: planning|running|waiting_user|verifying|complete|partial|failed|blocked|cancelled
  plan: [StepState]
  file_context_ref: string
  conversation_ref: string
  outputs: [ArtifactRef]
  verified_effects: [EffectRecord]
  pending_actions: [PendingAction]
  context_snapshot_ref: string
  created_at: timestamp
  updated_at: timestamp
```

There is no `project_id`. `file_context_ref` identifies the explicit manifest for this Work.

## 4. Checkpoints and recovery

A checkpoint occurs at least:

- after a plan step ends;
- before a high-impact action waits for confirmation;
- after context compaction;
- before a user pause or process exit.

Recovery first checks file fingerprints and unfinished actions. When external files changed, the runtime marks dependent conclusions stale and reads or verifies them again instead of reusing old state blindly.

## 5. Context Manager

Context Manager produces distinct projections for Chat, Prompt Enhancement, the primary agent, and subagents:

- the current user goal and necessary conversation;
- the current Work's file manifest, relevant summaries, and on-demand bodies;
- tool results needed by the current step;
- relevant and permitted long-term memory;
- explicit exclusion of irrelevant history, files, and expired memory.

Large content stays reference-oriented and is read on demand rather than repeatedly inserting complete bodies into context.
