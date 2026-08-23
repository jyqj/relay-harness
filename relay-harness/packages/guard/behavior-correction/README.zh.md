# @relay-harness/rlh-behavior-correction

[English](README.md) | 中文

一个停止边界行为纠正器，不是模型可见的工具：它不出现在工具列表中，也不否决任何调用。它监听每个 agent 的 `agent/turn-stopping` 边界，当即将结束的轮次以模型行为偏差收尾时，向该轮次注入恰好一条纠正消息，让模型重新进入循环，而不是带着偏差结束。决定权仍在模型；所有上限都允许轮次正常关闭。先行实践：GenericAgent 的 `do_no_tool` 纠正层。

按以下检查顺序检测三种偏差：

- **空回复** —— 收尾的 assistant 消息不含可见文本（适配器尚未归类为 `EMPTY_RESPONSE` 的退化输出，例如纯空白）。连续空回复跨轮次计数；达到 `maxConsecutiveEmpty` 时守卫放弃并让轮次关闭，因为持续空回复的模型不会被又一条相同的提示修好。
- **未执行代码** —— 在没有任何工具调用的轮次里，收尾回答包含围栏代码块。描述命令或编辑并不等于执行；纠正消息要求模型调用工具，或者不带代码块地收尾。
- **未验证完成** —— 在没有任何工具调用的轮次里，收尾回答命中完成声明模式，而同一会话更早的轮次有过工具调用。纠正消息要求一次验证性工具调用或给出理由，从而抑制工作会话中"无证据宣布完成"的收尾，同时不影响纯聊天会话（没有历史工具活动就不会被质疑）。

以 `max-tokens` 截断结束的轮次不算偏差，交由 `@relay-harness/rlh-token-budget-controller` 处理；本轮发生过任何工具调用的轮次不会被代码块或完成声明天规则质疑。

## 配置

```yaml
- id: behavior-correction
  name: '@relay-harness/rlh-behavior-correction'
  config:
    maxCorrectionsPerTurn: 1       # default; corrections allowed per turn across all detectors
    maxConsecutiveEmpty: 3         # default; consecutive empty closings tolerated before giving up
    emptyAnswer: true              # default; detector toggle
    unexecutedCode: true           # default; detector toggle
    unverifiedCompletion: true     # default; detector toggle
    completionPatterns: [...]      # default English and Chinese claim phrases, matched case-insensitively
```

所有取值都在插件加载时 fail loud：非整数或低于下限的上限、空模式、无法编译的模式，以及在 `unverifiedCompletion` 开启时给出空的 `completionPatterns` 列表，都会抛出异常，绝不静默回退到默认值。`unverifiedCompletion` 关闭时，空的 `completionPatterns` 列表是合法的。

## 检测与投递语义

检测是在停止边界读取会话日志的纯函数：该轮次最后一个 finish chunk 必须是普通的 `stop`，收尾 assistant 消息取该轮次最后一条，工具活动按轮次统计（`tool/call` 事件）。纠正消息经 `agent.steer(...)` 以插件来源的 `user/message` 注入（来源 `{kind: 'plugin', plugin: 'behavior-correction'}`），循环随后重读收件箱并在同一轮次再跑一步；该消息模型可见、来源可溯，且无需新会话事件即可从会话日志重建。

状态按 agent 隔离且仅在内存中：`WeakMap<Agent, …>` 以存活 agent 对象和轮次号为键记录纠正计数，一个 agent 的偏差不会消耗另一个的额度，对象生命周期即条目边界。从持久化恢复的会话以全新计数开始——守卫是启发式提示而非持久不变量，恢复后偶发的重复纠正是可接受代价。当多个插件监听同一边界时，由数据决定结果：本守卫从不在 `max-tokens` finish 上触发，token 预算控制器从不在 `stop` finish 上触发，因此监听器顺序不会产生相互竞争的注入。

## 模型体验

### 纠正性上下文消息

#### 模型看到的内容

每轮次至多 `maxCorrectionsPerTurn` 条插件来源的用户消息，各指明一种偏差。

##### 空回复纠正

```markdown
Your previous response was empty: it contained no text and no tool calls. If the task is complete, state the result explicitly; otherwise continue working on it.
```

##### 未执行代码纠正

```markdown
You produced a code block but did not call any tool, so nothing was executed. Describing a command or edit does not perform it. If the code was meant to run, call the appropriate tool now; if the task is already complete, conclude without the code block.
```

##### 未验证完成纠正

```markdown
You declared the task complete, but this turn made no tool call that verifies the result. Before concluding, verify with a tool call (run the tests, re-read the changed file, or check the effect). If you are certain no verification is needed, explain why.
```

#### Token 影响

无偏差时零 token。每条纠正是一条短消息，成为该 agent 的保留历史，并按轮次限界。

#### KV 缓存影响

仅追加；纠正消息跟在可复用的请求前缀之后，不会使已有 KV 缓存失效。

## 已知限制与后续工作

- **启发式而非理解** —— 说明性文字中的围栏代码块可能让未执行代码检测误报，完成声明模式也无法读懂意图；上限把代价限制在每轮一条额外消息。
- **计数不跨恢复保留** —— 每轮与连续计数在会话重载后从零开始。
- **不做跨轮次完成追踪** —— 未验证完成检测只判断收尾轮次；分散在多个轮次中的完成声明不在范围内。
