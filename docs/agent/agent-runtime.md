# Agent Runtime

## 1. Agent Loop

work 使用固定闭环：

```text
understand  读取用户目标、当前对话与显式 File Context
plan        形成可执行步骤和每步验收条件
act         调用工具、Skill 或创建 Subagent
observe     读取结构化结果并更新 Work State
verify      本地确认预期效果是否成立
decide      继续、请求最小输入、部分交付、失败或完成
```

硬规则：

1. 每轮必须推进状态或给出明确阻塞原因。
2. 工具调用成功不能直接把任务标记为完成。
3. 高影响动作必须经过权限门。
4. 技术错误先在内部恢复，不把原始堆栈直接甩给普通用户。
5. 验证结果只进入本地 Work State，不发送给调度侧。

## 2. 终态

```text
complete   验收条件全部满足
partial    已有可交付结果，但部分目标未完成
failed     已尝试合理恢复，仍无法完成
blocked    缺少用户输入、权限或外部条件
cancelled  用户取消
```

`blocked` 可以恢复执行；其余为一次 Run 的终态。用户继续修改目标时创建新 Run，并保留同一 work 的上下文。

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

这里没有 `project_id`。文件范围由 `file_context_ref` 指向本次 work 的显式清单。

## 4. Checkpoint 与恢复

checkpoint 至少发生在：

- 一个计划步骤结束后；
- 高影响动作等待确认前；
- 上下文压缩后；
- 用户暂停或进程退出前。

恢复时先检查文件指纹和未完成动作。外部文件已变化时，将相关结论标记为 stale 并重新读取或验证；不盲目沿用旧状态。

## 5. Context Manager

Context Manager 为 chat、Prompt Enhancing、主 Agent 和 Subagent 生成不同投影：

- 当前用户目标与必要对话；
- 当前 work 的文件清单、相关摘要和按需正文；
- 当前步骤需要的工具结果；
- 与请求相关且允许使用的长期记忆；
- 明确排除无关历史、无关文件和已过期记忆。

大内容以引用和按需读取为主，不重复把全文铺入上下文。

