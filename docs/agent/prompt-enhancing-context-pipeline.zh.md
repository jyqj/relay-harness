# Prompt Enhancement 上下文管线

[English](prompt-enhancing-context-pipeline.md) | 中文

> 本文定义 Prompt Enhancement 如何收集、选择和展示上下文。产品交互见 [`prompt-enhancing.md`](prompt-enhancing.md)，确切运行时约定见 [`../subsystems/prompt-enhancement.md`](../subsystems/prompt-enhancement.md)。

## 1. 核心结论

Chat 与 Work 共用同一次 Context Engine pass。Session identity 与已组合 contributor 决定可用 Evidence；Relay 不为增强维护第二套检索系统：

- 已完成的当前 session exchange 提供有界历史；
- 显式 File Context、Code Index、治理型 Memory 与显式 MCP resource 通过各自 provider contribution；
- 每条已接纳观察都保留来源、revision、新鲜度与验证事实；
- 当前配置的 agent route 选择辅助模型，不暗示尚未交付的外部调度客户端。

```text
Unsent draft
  + Session History
  + Explicit File / Code / Memory / MCP contributors
        ↓
Context Engine prepareStep(purpose=prompt_enhancement)
        ↓
No-tools auxiliary model request
        ↓
Generated Remote result + Context Trace
        ↓
Review diff and sources; never submit automatically
```

## 2. 浏览器请求

产品 UI 只通过生成的 Remote 发送精确当前草稿、当前 session identity 与取消信号：

```yaml
prompt_enhancement_remote:
  session_id: string
  draft: string
  signal: AbortSignal
```

Chat 与 Work 使用同一个 Remote。Host 解析当前 agent/session；缺失或不匹配状态会被拒绝，而不会接受浏览器自行组装的上下文 payload。

## 3. 当前输入

精确草稿成为 `purpose=prompt_enhancement` 的 claimed user message，并为增强 provider 单独 framing：

```yaml
context_input:
  purpose: prompt_enhancement
  claimed_message: exact_unsent_draft
  caller: session|agent|workspace|preset|origin
```

附件和其他富输入只通过各自拥有的显式引用 contributor 进入，不会与草稿正文混合。

## 4. 对话历史投影

Session History contributor 只接纳：

- 已完成的直接用户/assistant exchange；
- 已批准的 compaction checkpoint；
- 符合字符与 token budget 的有界时间顺序选择；
- 绑定确切 session event 与 revision 的 Evidence。

Recall/injected message、tool traffic、失败或未完成 turn，以及未批准 checkpoint 都会被排除，避免递归上下文和未提交状态成为历史。

## 5. History hydration

每条已接纳历史观察都会记录持久 session event key、event revision、digest、role 与选择原因：

| 观察 | 投影事实 |
|---|---|
| User message | 已完成的直接用户 exchange 内容 |
| Assistant message | 已完成的模型 exchange 内容 |
| Approved checkpoint | 已压缩对话区间与批准 identity |
| Budget-clipped unit | 确切源 event 集合与 truncated Evidence 标记 |
| Excluded unit | 不带模型可见内容的 coverage 原因 |

缺失、失败或未完成观察不会静默复用旧文本。

## 6. 文件与检索上下文

显式引用约束每个面向文件的 contributor：

```yaml
retrieval_scope:
  workspace_id: string
  explicit_file_refs: [string]
  indexed_workspace: selected_workspace_only
  mcp_resources: explicit_uri_only
```

规则：

1. 文件内容必须在当前请求 scope 中具有显式引用。
2. 代码检索通过用户选择的 workspace 路由。
3. Provider 可以搜索本地 manifest 或索引，但不会把完整 source 发送给增强模型。
4. Hydration 把已接纳内容绑定到当前 revision，并记录 missing/stale 状态。
5. 选择或引入 scope 外的文件不能被隐式扫描。
6. MCP resource 内容只从显式 URI 进入，并保持 external、untrusted 标记。

## 7. Rules、guidelines 与 memory

### Rules

适用的 agent instruction 与已选 skill 要求可以约束建议，但 source 内容不能改变 Prompt Enhancement 系统提示词或取得 tool 权威。

### Guidelines

用户与当前任务 guidance 只通过已组合、可归属的 contributor 到达增强。文件夹级 instruction 只有在该文件夹位于当前显式上下文时才生效。

Rules、guidelines 与长期记忆保持分离：rules 约束行为，guidelines 表达用户指引，Memory 提供经过治理的跨 session 事实或偏好；三者不会静默覆盖彼此。

## 8. Chat 与 Work 的投影差异

| 逻辑 | Chat | Work |
|---|---|---|
| 当前草稿 | 相同 | 相同 |
| Context Engine | 相同 | 相同 |
| Session history | 当前 Chat session | 当前 Work session |
| 文件检索 | 显式引用 + 已选 workspace | 显式引用 + 已选 workspace |
| Memory | 精确 caller scope | 精确 caller scope |
| MCP resources | 仅显式 URI | 仅显式 URI |
| 模型 route | 当前配置的 agent route | 当前配置的 agent route |
| Accept/undo | 浏览器草稿事务 | 浏览器草稿事务 |

Mode 不启用检索。Contributor 根据显式 purpose、caller identity、草稿与自有 scope 作出决定。

## 9. 空历史处理

没有符合条件的历史时：

- 精确当前草稿仍然存在；
- 显式 file、code、Memory 与 MCP contributor 仍按各自准入规则运行；
- 没有适用内容的 contributor 不增加内容；
- trace 记录实际存在的 contribution 与 coverage，而不会编造连续性。

因此首次 Work 不需要伪造 Chat mode 才能检索显式上下文。

## 10. 模型请求与浏览器结果

Context Engine 准备完成后，Host 发送不带 tool、具有稳定 Prompt Enhancement instruction 的独立请求。Provider 返回严格 JSON：

```yaml
prompt_enhancement_result:
  originalDraft: string
  enhancedDraft: string
  assumptions: [string]
  openQuestions: [string]
  model: {provider, model}
  contextTrace: JsonValue|null
```

生成的 Remote 只在验证完成后返回完整建议。浏览器展示原文/增强 diff、assumption、question 与已接纳来源解释。只有草稿值和单调 revision 仍匹配本次尝试时，Accept 才会替换草稿；Undo 使用另一次 revision 检查。取消、失败、session 变化或陈旧结果都会保留当前草稿。

## 11. 采纳决策

| 机制 | 当前决定 |
|---|---|
| Chat/Work 共用上下文收集 | 使用一次带 purpose 的 Context Engine pass |
| 精确当前草稿 | 保持为单独 framing 的输入 |
| 已完成 exchange 与已批准 checkpoint | 通过 Session History Context 准入 |
| File/code/memory/MCP 检索 | 复用各自拥有的 Context Engine contributor |
| 显式文件与外部资源 | 作为一等 scoped input |
| 来源解释 | 把既有 Evidence 投影进结果 trace |
| 浏览器选择模型 | 拒绝；Host 使用当前配置的 agent route |
| Agent loop 执行 | 拒绝；辅助请求不暴露 tool |
| 自动替换草稿 | 拒绝；要求 diff 审阅与显式 Accept |
| 无条件应用延迟结果 | 拒绝；使用值 + revision compare-and-set |
| 自动提交 | 拒绝；增强只改变草稿状态 |
| Context Engine 缺失回退 | 已发布 Web composition 拒绝；错误组合会明确失败 |

## 12. 验收标准

1. Chat 与 Work 对相同草稿和 scope 使用同一次 Context Engine pass。
2. 首次 Work 没有符合条件的历史时仍能检索显式引入的上下文。
3. 显式/已选 scope 外的文件不会进入检索或模型请求。
4. 已完成 exchange 与已批准 checkpoint 保持对持久 event 的归属。
5. 历史受到预算限制，遗漏仍通过 coverage 可见。
6. File、Code、Memory、History 与 MCP Evidence 保持不同 provenance。
7. 浏览器展示已接纳来源的 why、freshness 与 verification。
8. Enhance 不创建 Work、不执行 tool、不提交 message。
9. 取消、失败和陈旧响应都会保留当前草稿。
