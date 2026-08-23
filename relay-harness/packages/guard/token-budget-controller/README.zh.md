# @relay-harness/rlh-token-budget-controller

[English](README.md) | 中文

一个停止边界的输出预算覆写器，不是模型可见的工具：它不出现在工具列表中。当轮次以 `max-tokens` finish 结束——模型在回答中途触及输出 token 上限被截断——控制器覆写这次停止，向即将关闭的轮次注入一条继续提示，让模型从截断处接着写，而不是把任务留在半成品状态。先行实践：token 预算元控制器模式（带收益递减检测的 continuation）。

两条边界保证 continuation 不失控：

- **每轮上限** —— 每轮次至多 `maxContinuations` 条继续提示；轮次号变化时计数重置。
- **收益递减检测** —— 每次 continuation 的实际产出（该步的 `usage.outputTokens`）与 `minUsefulDeltaTokens` 比较；连续 `maxLowDeltaStreak` 次产出不足的 continuation 之后，控制器停止注入，因为对每条提示都只回以近乎空输出的模型已经没有内容可说。未上报 usage 的 continuation 按产出充足计——这类情形仅由每轮上限约束。

以普通 `stop` finish 结束的轮次不属于本控制器的管辖范围，交由其他停止边界监听器（包括 `@relay-harness/rlh-behavior-correction`）处理。

## 配置

```yaml
- id: token-budget-controller
  name: '@relay-harness/rlh-token-budget-controller'
  config:
    maxContinuations: 8        # default; continue nudges allowed per turn
    minUsefulDeltaTokens: 500  # default; output tokens below which a continuation is unproductive
    maxLowDeltaStreak: 2       # default; consecutive unproductive continuations that stop steering
```

所有取值都在插件加载时 fail loud：非整数或低于下限的值会抛出异常，绝不静默回退到默认值。

## 决策与投递语义

决策是在 `agent/turn-stopping` 读取会话日志的纯函数：该轮次最后一个 finish chunk 必须是 `max-tokens`，每步产出序列取该轮次 `assistant/message` 的 usage（初始截断响应在前，之后每次 continuation 一条）。继续提示经 `agent.steer(...)` 以插件来源的 `user/message` 注入（来源 `{kind: 'plugin', plugin: 'token-budget-controller'}`），循环随后重读收件箱并在同一轮次再跑一步；该消息模型可见、来源可溯，且无需新会话事件即可从会话日志重建。

状态按 agent 隔离且仅在内存中：`WeakMap<Agent, …>` 以存活 agent 对象和轮次号为键记录 continuation 计数。从持久化恢复的会话以全新计数开始——控制器是启发式覆写而非持久不变量，恢复后偶发的一次重复提示是可接受代价。继续提示不改变 `maxTokens`：API 级上限仍然约束每一步，控制器约束的是其后的 continuation 次数。

## 模型体验

### 继续提示

#### 模型看到的内容

每轮次至多 `maxContinuations` 条插件来源的用户消息。

##### 继续提示

```markdown
Your previous response was cut off at the output token limit, before you finished. Continue exactly where you left off: do not restart, do not summarize or repeat what you already produced, and call any tool needed to complete the remaining work.
```

#### Token 影响

轮次正常结束时零 token。每条提示换取一次额外的模型调用；每轮上限与收益递减检查约束 continuation 总开销。

#### KV 缓存影响

仅追加；提示消息跟在可复用的请求前缀之后，不会使已有 KV 缓存失效。

## 已知限制与后续工作

- **不管输入侧预算** —— 控制器只管输出 continuation；上下文窗口压力仍由 compaction 引擎负责。
- **计数不跨恢复保留** —— 每轮 continuation 计数在会话重载后从零开始。
- **usage 以适配器上报为准** —— 提供方误报 `outputTokens` 会干扰收益递减检查；未上报 usage 时回退到仅由上限约束。
