# @relay-harness/rlh-llm-circuit-breaker

[English](README.md) | 中文

这是一个 opt-in、提供方局部的 Agent 模型请求滑动窗口 circuit breaker。它不是工具，也不添加 prompt text。Failure 与成功 `assistant/message` outcome 会进入每个 provider route 一张 breaker；open breaker 会在 transport 工作前的 `agent/request` 以 `LlmError('CIRCUIT_OPEN')` 和有界 `providerRetryAfterMs` 拒绝。

## 配置

| Key | 默认值 | 含义 |
|---|---:|---|
| `windowMs` | `60000` | live outcome window。 |
| `minSamples` | `5` | trip 前要求的 sample。 |
| `errorRateThreshold` | `0.5` | 从零到一的 failure ratio。 |
| `openMs` | `60000` | open cool-down 与 abandoned half-open probe lease。 |
| `halfOpenMaxProbes` | `1` | 并发 recovery probe。 |
| `failureCodes` | `EMPTY_RESPONSE,RATE_LIMIT,SERVER,TIMEOUT,TRANSPORT` | 计为 breaker failure 的错误。其他失败响应计为成功 connectivity sample。 |

时间与阈值默认值沿用吸收的 client-side 先行 preset。RLH failure-code set 替代其 HTTP-only `401` preset，因为 RLH adapter 已把 transport 与 provider failure 规范化为这些 provider-neutral code。基础 bundle 不加载本包；部署显式 opt in。

## 状态机

Closed request 直接通过。每个 terminal request outcome 会进入 live window；达到 `minSamples` 后，failure ratio 等于或超过阈值就会打开 provider。Open request 不执行 transport 工作，并报告剩余 cool-down。经过 `openMs` 后，一个 caller 会原子进入 half-open 并 claim probe。Probe success 会关闭并清空历史；probe failure 会重新打开。额外 probe 会收到 50 ms 有界 backoff。始终不报告 outcome 的 probe 会在一个 `openMs` lease 后被 reclaim，因此取消无法让 half-open 永久卡住。

每次准入都会返回获准时的 breaker 状态，每个 outcome 都按该 stamp 结算：closed 准入的 outcome 只进入 live window，且只能从 closed 触发 trip；half-open 准入的 outcome 只释放它自己 claim 的 probe slot，也只有它能关闭或重新打开 breaker。因此 trip 前已准入的在途请求无法关闭或重新打开 half-open，任何 outcome 都不会消费它从未 claim 的 probe slot；probe lease 已被 reclaim 的 outcome 属于过期 outcome，不改变任何状态。live window 最多保留 1000 个 outcome，超出后按最旧优先丢弃。

Breaker 以解析后的 `LlmCallConfig.provider` 为 key，并在后续 `agent/request` listener 返回 route 后检查。`agent/request` 会按 agent 与 provider 保存每张 admission stamp；由于一个 agent 同一时刻至多驱动一个 model request，`agent/request-error` 与已提交 assistant message 结算的正是它之前那个请求的 stamp，而被 shed 的请求不做任何准入、也不记录任何 outcome。`agent/request-error` 把配置 code 记为 failure，把其他 code 记为 connectivity success；已提交 assistant message 则根据其持久 provider source 记录 success。Provider route 绝不共享 window。

## 模型体验

### Open-circuit failure

#### 模型看到的内容

breaker 本身不会向模型发送任何内容：请求不会到达模型。Host 会观察到普通 Agent error，code 为 `CIRCUIT_OPEN`，message 为 `provider "<provider>" circuit breaker is open`，并带 retry delay。

#### Token 影响

被 shed 的请求不消耗模型 token；成功与失败 probe 调用正常消耗。

#### KV Cache 影响

open 时不发送请求，因此不改变 cache entry。

## 已知限制与后续工作

- 状态是进程局部的，并在插件 reload 时重置；它不是分布式 provider-health service。
- 另一 outcome 触发 breaker 时已经在途的请求会继续并正常报告；其 outcome 按获准时的 stamp 结算，无法关闭或重新打开 half-open。
- 未配置 failure code 会计为成功 connectivity，因此 authentication 或 caller-invalid failure 不会打开 transport／provider availability circuit。
