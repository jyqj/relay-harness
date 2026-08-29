# Prompt Enhancing

[English](prompt-enhancing.md) | 中文

## 1. 产品行为

Prompt Enhancing 是**提交前的用户主动操作**：

1. 用户在输入框中写草稿；
2. 用户点击 `Enhance`；
3. 系统构造专用上下文并请求优化；
4. 优化建议经过审阅后回到输入框；
5. 用户继续编辑、撤销或自行提交。

点击 `Enhance` 不等于发送消息，不创建 work，也不触发工具执行。

## 2. 合理上下文

Chat 与 Work 共用同一个 Context Engine；详细的历史投影、hydration、文件检索、Rules/Guidelines 和空历史语义见 [`prompt-enhancing-context-pipeline.md`](prompt-enhancing-context-pipeline.md)。

Context Engine 只选择与当前草稿直接相关的内容：

| 来源 | 使用规则 |
|---|---|
| 当前草稿 | 必选，保持核心意图 |
| 当前会话 | 选择能够消除指代、补足已确认约束的片段 |
| 当前 work | 若存在，仅使用目标、当前状态和相关步骤 |
| File Context | 使用文件名、类型、用户说明和相关摘要；正文按需读取 |
| 长期记忆 | 仅使用与草稿相关、允许使用且未过期的信息 |
| 能力说明 | 可补充 Relay 能提供的输出形式和验收方式 |

禁止把无关会话、整段历史、未引入文件或无关记忆塞入增强请求。

## 3. 输出契约

```yaml
enhance_result:
  enhanced_draft: string
  assumptions: [string]
  unresolved: [string]
  context_refs: [string]
```

界面通过 diff 建议 `enhanced_draft`；假设和未决项保持可查看。任何未获上下文支持的内容不得写成确定事实。

## 4. 优化目标

- 明确目标和期望产物；
- 补齐上下文中已经确定的约束；
- 把模糊指代改成可理解表达；
- 需要时加入验收要求；
- 保持用户语言、语气和原始意图；
- 不擅自扩大任务范围。

## 5. 交互要求

- 原草稿可一键撤销恢复；
- 连续点击基于当前输入框内容重新增强；
- 增强失败不影响原草稿；
- 文件或记忆被使用时，可展开查看来源类别；
- 敏感内容遵循当前会话或 work 的数据边界。
