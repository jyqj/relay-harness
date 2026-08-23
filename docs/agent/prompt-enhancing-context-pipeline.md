# Prompt Enhancing 上下文管线

> 本文定义 Prompt Enhancing 如何收集、投影、检索和发送上下文。产品交互见 [`prompt-enhancing.md`](prompt-enhancing.md)。

## 1. 核心结论

Chat 与 Work 共用同一套 `EnhancerContextComposer`。差异只体现在会话语义和可用事件类型，不维护两套检索系统：

- Chat 主要包含普通对话历史和会话附件；
- Work 额外包含计划状态、工具结果摘要、checkpoint 和文件编辑事件；
- 文件检索始终受当前 `File Context` 约束；
- 模型选择始终交给外部中转调度侧。

```text
输入框草稿
  + Conversation Projection
  + File Context Retrieval
  + Rules / Guidelines
  + Relevant Memory
        ↓
EnhancerContextComposer
        ↓
route_request(mode=prompt_enhance)
        ↓
SSE 返回增强草稿
        ↓
替换输入框内容，不自动提交
```

## 2. 客户端请求

产品界面只提交当前草稿和上下文定位信息，不传整个富文本编辑器内部结构：

```yaml
enhance_prompt_request:
  draft: string
  conversation_id: string
  work_id: string|null
  explicit_file_refs: [string]
  external_source_refs: [string]
  use_history_summary: bool
```

`work_id=null` 表示 Chat。Work 也使用同一接口，不创建专用 Prompt Enhancer。

## 3. 当前输入

当前草稿包装为一个文本节点：

```yaml
context_node:
  id: string
  type: text
  content: string
  source: current_draft
```

增强器只处理尚未提交的文字草稿。附件和其他富文本节点通过显式引用进入 Context Composer，不与草稿正文混为一体。

## 4. 对话历史投影

Context Composer 从当前 conversation 事件流中只保留：

- 已成功完成的用户—助手 Exchange；
- history summary；
- checkpoint boundary；
- 与当前目标相关的文件/图片引用；
- Work 中必要的工具结果摘要和文件编辑事件。

失败重试、重复中间输出、调试堆栈和无关工具噪声不进入增强上下文。

启用 `use_history_summary` 时，较早历史使用压缩摘要；最近且与草稿直接相关的 Exchange 保留原始内容。摘要必须带原始事件范围引用，不能成为无法追溯的新事实。

## 5. History Hydration

历史中的引用在 Rust agent 侧完成 hydration：

| 引用类型 | Hydration 结果 |
|---|---|
| `FILE_REF` | 当前版本的文件文本、结构摘要或相关片段 |
| `IMAGE_REF` | 受大小限制的图片内容或视觉摘要 |
| `CHECKPOINT_REF` | checkpoint 对应的计划状态和必要编辑事件 |
| `EDIT_REF` | 文件、变更范围和结果摘要 |
| `ARTIFACT_REF` | 本次 work 产物的类型、摘要和按需正文 |

无法解析、已移除或 fingerprint 变化的引用标记为 missing/stale，不静默使用旧内容。

## 6. 文件检索上下文

参考实现中“始终携带 workspace blobs 索引”的思想保留，但作用域改为 Relay 的显式文件边界：

```yaml
retrieval_scope:
  file_context_id: string|null
  manifest:
    - {file_ref, display_name, media_type, fingerprint, summary_ref}
  explicit_file_refs: [string]
  external_source_refs: [string]
```

规则：

1. Chat 使用当前 conversation 已引入的附件清单。
2. Work 使用当前 work 的完整 File Context manifest。
3. manifest 可以始终交给本地检索器，但不代表把所有文件正文送入模型。
4. 本地检索器根据草稿、历史和显式引用选择相关片段，再完成 hydration。
5. 未显式引入当前会话/work 的文件不进入 manifest，也不能被隐式扫描。
6. `explicit_file_refs` 和 `external_source_refs` 是一等输入，不能像参考实现的 Webview 路径一样长期为空而失去作用。

## 7. Rules 与 Guidelines

### Rules

Rules 是结构化约束，例如 Skill 输出契约、文件操作限制和当前任务规则。客户端或 Rust agent 根据 active context 过滤，只发送适用于当前草稿的规则。

### Guidelines

Guidelines 分为：

- 用户明确设置的全局 Guidelines；
- 当前 work 的临时 Guidelines；
- 当前 File Context 所带的使用说明。

Relay 不使用 Workspace Guidelines 这一产品概念。文件夹级说明只有在该文件夹已被引入当前 File Context 时才可生效。

Rules、Guidelines 与长期记忆分开：Rules 是约束，Guidelines 是用户指引，Memory 是跨会话事实或偏好，三者不能互相静默覆盖。

## 8. Chat 与 Work 的投影差异

| 逻辑 | Chat | Work |
|---|---|---|
| 当前草稿 | 相同 | 相同 |
| 历史收集器 | 相同 | 相同 |
| 文件检索器 | Conversation File Context | Work File Context |
| Rules | 按 active context 过滤 | 按 active context 过滤 |
| Guidelines | 用户 + 会话 | 用户 + work + 文件说明 |
| 历史事件 | 普通 Exchange、附件 | 另含工具摘要、checkpoint、编辑事件 |
| `conversation_semantics` | `chat` | 有 Agent 事件时为 `agent`，否则为 `chat` |
| 模型选择 | 调度侧 | 调度侧 |

`conversation_semantics` 只告诉模型如何解释历史结构，不控制是否执行检索。

## 9. 空历史处理

空历史时使用 `conversation_semantics=chat`，但**不依赖该模式触发检索**：

- 当前草稿始终存在；
- Chat 附件或 Work File Context manifest 仍会进入本地检索；
- Rules、Guidelines 和相关长期记忆仍按正常流程处理；
- 首次 Work 因没有 Agent 历史而采用 chat 语义，不会丢失文件上下文。

这保留了参考实现的兼容行为，同时消除了“通过切换模式才能强制 retrieval”的隐式耦合。

## 10. 调度调用与流式回填

Context Composer 完成检索和 hydration 后，构造：

```yaml
route_request:
  mode: prompt_enhance
  conversation_semantics: chat|agent
  signal_mode: pre_classify
  input:
    prompt_enhance_context:
      current_draft: ContextNode
      history: [Exchange]
      retrieved_context: [ContextNode]
      rules: [Rule]
      guidelines: [Guideline]
      memory_context: [ContextNode]
```

具体模型由调度侧选择。agent 不固定 Chat 模型、Agent 模型，也不复用会话模型作为硬约束。

增强结果通过 SSE 流式返回。UI 在成功完成后一次性替换输入框草稿；取消或失败时保留原草稿，不使用 XML 标签截取结果。

## 11. 采纳决策

| 参考机制 | 当前决定 |
|---|---|
| Chat/Work 共用上下文收集逻辑 | 直接采纳 |
| 当前输入只传文本节点 | 采纳，附件走独立引用 |
| 成功 Exchange、checkpoint、summary 投影 | 采纳 |
| 文件、图片、checkpoint、编辑事件 hydration | 采纳，放在 Rust agent 侧 |
| history summary 控制历史长度 | 采纳，增加来源范围引用 |
| 始终提供 blob 索引供检索 | 改造后采纳：仅当前显式 File Context manifest |
| Rules 按 active context 过滤 | 采纳 |
| 用户级 + Workspace Guidelines | 改造后采纳：用户 + work + 文件说明 |
| 显式文件与外部源长期为空 | 不采纳，作为一等输入 |
| 客户端选择 Chat/Agent 模型 | 不采纳，模型选择归调度侧 |
| 空历史切 Chat 以强制 retrieval | 不采纳该耦合；检索独立执行 |
| 固定 Agent mode + XML 提取 | 不采纳，使用专用模式和结构化 SSE |

## 12. 验收标准

1. 相同草稿和相同作用域在 Chat/Work 下经过同一个 Composer，仅投影差异不同。
2. 首次 Work 即使没有历史，也能检索已引入文件。
3. 未引入文件不会出现在 manifest、检索结果或增强请求中。
4. Work 历史中的 checkpoint 和编辑引用可以恢复为模型可理解的上下文。
5. 启用 summary 后不无限携带完整历史，并能回查摘要来源。
6. Rules、Guidelines、Memory 的来源与优先级可区分。
7. `explicit_file_refs` 和 `external_source_refs` 能实际影响检索结果。
8. Enhance 不创建 work、不执行工具、不自动提交。
9. 取消或失败时原输入不丢失。
