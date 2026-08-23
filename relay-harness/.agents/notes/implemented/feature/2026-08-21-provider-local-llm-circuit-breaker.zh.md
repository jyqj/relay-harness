# Agent Note: 提供方局部 LLM circuit breaker

Status: implemented

[English](2026-08-21-provider-local-llm-circuit-breaker.md) | 中文

## Problem

请求 retry 可以恢复孤立 transient failure，但一个 provider route 的重复 failure 仍会让每个 Agent 消耗 transport latency 与 retry budget。进程需要一项共享 provider-health 决策：在已观察 outage 期间 shed 新调用、准入有界 recovery probe，并且永不阻塞无关 provider。

## Decision

`@relay-harness/rlh-llm-circuit-breaker` 是 opt-in guard 插件。它为每个解析后的 provider route 持有一个 `CircuitBreaker`，并在下游 `agent/request` route selection 后、transport dispatch 前检查。open route 会抛出 code 为 `CIRCUIT_OPEN` 的 `LlmError`，并把剩余 cool-down 作为 `providerRetryAfterMs`。

状态机使用 live time window、minimum sample count、failure-rate threshold、open duration 与有界 half-open probe。默认值沿用吸收的 client preset：60 秒 window、五个 sample、0.5 threshold、60 秒 open duration 和一个 probe。RLH provider-neutral transient failure code 替代参考实现的 HTTP-specific client code。其他错误计为成功 connectivity sample，因此 authorization、invalid argument 与 quota ownership 不会声称 provider unavailable。

已提交 assistant message 根据持久 provider source 记录 success。`agent/request-error` 会在委托 recovery 前记录每次失败 attempt，因此 retry 贡献其实际 outcome。如果取消使 half-open probe 始终没有 outcome，该 slot 会在一个 open duration 后 reclaim；success 关闭并清空历史，failure 重新打开。Provider map 为进程局部且彼此隔离。

## Alternatives considered

**把 breaker 加进每个 adapter。** 不予采用，因为 adapter 会重复状态机，而且使用同一注册 route 的 Agent 未必共享 health。

**合并进 retry policy。** 不予采用，因为 retry 拥有一个失败请求的 recovery；breaker 拥有后来独立请求的 admission。混合会使 retry count 与 circuit sample 相互递归。

**使用一个全局 circuit。** 不予采用，因为一个失败 provider 会 shed 健康 route。

**对每个 error code trip。** 不予采用，因为 auth、invalid argument 与 quota ownership 可以是 caller-specific，并不能证明 transport／provider outage。

**允许无限 half-open probe。** 不予采用，因为 recovery stampede 会抵消 open period。一个 probe 是吸收的 client preset；配置可以提高。

**持久化 breaker state。** 不予采用，因为 wall-clock cool-down 与 in-flight probe 属于进程 health，而非持久 conversation fact。reload 会从 closed 开始。

## Consequences

重复配置 failure 会在网络工作前 shed 后续调用，并公开稳定可 retry delay。成功 probe 恢复流量，失败 probe 重新打开，abandoned probe 会自愈，provider route 保持独立。

已运行请求可能超过 trip point。插件刻意不进入基础 bundle，直到部署 opt in 其 provider-health policy。

纯状态机、真实 Agent-loop 与 Loader-YAML 测试覆盖 window eviction、trip／open delay、half-open exclusion、abandoned-probe reclaim、success close、failure reopen、provider isolation、failure-code classification、pre-transport shedding、validation 与 invariant 注册，并达到逐文件 100% coverage。
