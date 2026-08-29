# @relay-harness/rlh-prompt-enhancement-llm

[English](README.md) | 中文

`ctx.promptEnhancement` 的模型提供方。它在要求辅助模型返回包含 `enhancedDraft`、`assumptions` 和 `openQuestions` 的严格 JSON 时，保留用户意图、语言、范围、约束和请求输出。调用原样接收共享 Context Engine 消息，增加一条 JSON framing 的草稿消息，不暴露工具，在 AgentLoop 之外执行，并且绝不提交或修改 Agent。

配置成对的显式 route 时优先使用它，否则使用 live Agent route，再回退到已记录的请求 route。提供方按 UTF-8 字节限制完整 system-plus-message 请求和原始输出流，把调用方取消与 deadline 组合，拒绝工具调用和非 stop 结束原因，验证每项完整结果上限，并在 dispatch 前追加 `prompt-enhancement/llm-request`，使所有模型可见输入可持久恢复但不进入普通派生历史。

## 配置

`provider` 和 `model` 可选，但必须成对提供。`maxInputBytes`、`maxOutputTokens`、`maxOutputBytes`、`timeoutMs`、`maxDraftChars`、`maxListItems` 和 `maxItemChars` 拥有全部随部署变化的限制。

## 模型体验

### 辅助增强请求

#### 模型看到什么

模型看到已准备的 Context Engine 消息、`PROMPT_ENHANCEMENT_SYSTEM_PROMPT` 中的稳定指令，以及包含精确未提交草稿的一个 JSON 对象。请求没有工具 Schema。

#### Token 影响

独立请求受 `maxInputBytes`、`maxOutputTokens` 和增量 `maxOutputBytes` 流门禁限制。用户提交替换草稿前，其结果不增加主历史 Token。

#### KV Cache 影响

稳定 system 指令可能在辅助 route 内复用；已准备上下文与草稿变化只影响该辅助请求。

## 已知限制与延后工作

- 提供方接受 JSON 文本而非 provider-native structured output；格式错误或 fenced 输出会失败并保留原草稿。
