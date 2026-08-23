# Subagent 编排

## 1. 使用原则

Subagent 用于边界清晰、上下文可独立、适合并行的子任务。顺序依赖强、需要持续掌握全局状态或涉及高影响决策的工作留在主 Agent。

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

强制要求：

- `goal / boundaries / acceptance` 不得为空；
- `context_refs` 只能引用当前 work 有权访问的内容；
- `routing_signal.source` 必须为 `parent_agent`；
- 信号的侧重权重之和必须为 `1.0`；
- Subagent 不自行创建下一层 Subagent。

## 3. 隔离

- Subagent 不继承整个父会话，只得到 SubagentSpec 和必要上下文投影。
- 文件与工具权限不得超过父 work。
- 需要用户确认的动作返回主 Agent，不由 Subagent 直接询问用户。
- Subagent 不能写长期记忆。

## 4. 输出契约

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

主 Agent 负责校验契约、合并产物并执行整体本地验证。Subagent 自报完成不能直接使父 work 完成。

## 5. 取消与失败

- 用户取消 work 时向所有运行中的 Subagent 广播取消。
- 单个 Subagent 失败不自动取消其他独立任务。
- 错误先按可恢复、需要输入、不可恢复分类，再决定重试、降级为 partial 或交回主 Agent。
- 不通过“换更强模型级联”处理失败；模型选择始终由单次调用前的信号和调度侧策略决定。

