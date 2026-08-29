# @relay-harness/rlh-prompt-enhancement

[English](README.md) | 中文

Host 侧 Prompt Enhancement 服务与生成式 Remote 命名空间。`ctx.promptEnhancement` 接受一个增强提供方和一个共享 Context Engine 适配器，随后返回结构化建议，或携带精确原草稿的 `preserved` 结果。取消、提供方缺失和提供方错误都不会替换或提交草稿。服务会在上下文检索前拒绝超大草稿，通过无损 JSON snapshot 分离并限制完整 Remote 结果，且只暴露明确标记为客户端安全的能力错误；任意提供方错误消息不会穿越边界。

上下文适配器接收固定的 `prompt_enhancement` purpose，并返回已准备的 `UserMessage[]` 与可选的不透明 `JsonValue` trace。该服务不会自行检索历史、文件、Memory、索引或 MCP Resources，也不会定义平行的上下文 composer。部署缺少任一提供方时会通过保留草稿的结果明确失败。

## Remote API

`promptEnhancement.enhance(agentId, draft, signal?)` 通过 Typert 解析目标 Agent。成功结果包含 `originalDraft`、`enhancedDraft`、`assumptions`、`openQuestions`、模型来源，以及可选的 Context Engine trace。客户端负责 diff 展示、接受、撤销和取消。

## 模型体验

### 已准备的增强请求

#### 模型看到什么

已注册的增强提供方收到精确草稿，以及来自共享 Context Engine 适配器准备的 `UserMessage[]`。该服务本身不添加 Prompt 文本。

#### Token 影响

辅助请求的 Token 消耗由提供方拥有。用户随后提交增强草稿前，其输出和 trace 不进入普通 Agent 历史。

#### KV Cache 影响

辅助调用独立于主 Agent 请求，不改变其可复用前缀。

## 已知限制与延后工作

- 结果只属于单次请求；未来 Context Drawer 可以渲染不透明 trace，但该服务不持久化 UI 接受状态。
- 提供方和 Context Engine 取消是协作式的。注册释放会先发出取消，再等待已捕获尝试真正结束，不会在提供方工作仍运行时声称已静止。
