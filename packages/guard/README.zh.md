# guard/ — 循环卫生 guard 家族

[English](README.md) | 中文

行为 guard 插件监视 agent loop（智能体循环）中的无效模式，并强制执行单次调用预算。guard 是核心服务和扩展点的自包含消费方，而非可替换能力。

| 包 | 职责 | ctx key |
|---|---|---|
| [`repeat-tool-reminder/`](repeat-tool-reminder/README.md) | 针对重复工具调用的建议性提醒 | 监听工具和 agent 事件 |
| [`timeout-policy/`](timeout-policy/README.md) | 以部署策略形式设置单次工具调用截止时间 | 注册 `tools/execute` 监听器 |
| [`behavior-correction/`](behavior-correction/README.md) | 针对空回复、未执行代码块与未验证完成声明的纠正性注入 | 监听 `agent/turn-stopping` |
| [`llm-circuit-breaker/`](llm-circuit-breaker/README.md) | 提供方局部滑动窗口请求 shedding | 守卫 `agent/request`；记录请求 outcome |
| [`rollout-budget-controller/`](rollout-budget-controller/README.md) | 一棵 root Agent 树共享的加权 token 预算 | 统计 `assistant/message`；守卫 pre-step 与工具 |
| [`token-budget-controller/`](token-budget-controller/README.md) | max-tokens 截断时的有界继续提示 | 监听 `agent/turn-stopping` |

提醒作为 `additionalContexts` 随 `tools/post-execute` 决策传递，并作为来源于插件的 `user/message` 事件追加记录（[工具](../../docs/subsystems/tools.md)）；跨 `dsh-timeout`、能力终止与本策略层的超时拆分记录在[超时库 Agent Note](../../.agents/notes/implemented/architecture/2026-07-06-timeout-deadline-library.md)。
