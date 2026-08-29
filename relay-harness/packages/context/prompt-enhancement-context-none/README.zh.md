# @relay-harness/rlh-prompt-enhancement-context-none

[English](README.md) | 中文

供测试和明确禁用上下文检索的部署使用的显式纯草稿 Context 提供方。它注册一个返回空准备消息列表的提供方。已发布 Web 组合不使用该适配器；选择它必须是显式部署决策，不能作为 Context Engine 缺失时的静默回退。

## 模型体验

### 纯草稿增强

#### 模型看到什么

在 `messages: []` 下，Prompt Enhancement 模型只收到增强提供方的稳定指令和精确草稿。

#### Token 影响

上下文消息 Token 为零；增强提供方的请求仍消耗自身 Prompt 与输出 Token。

#### KV Cache 影响

独立辅助请求只随提供方指令和草稿变化。

## 已知限制与延后工作

- 该适配器有意不提供文件、Memory、会话历史、代码证据、coverage，或空选择以外的上下文 trace。
