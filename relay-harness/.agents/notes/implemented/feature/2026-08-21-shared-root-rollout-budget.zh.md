# Agent Note: 共享根会话 rollout 预算

Status: implemented

[English](2026-08-21-shared-root-rollout-budget.md) | 中文

## Problem

逐请求输出上限与 max-token continuation 上限无法约束长时间 agent rollout。root Agent 可以发出许多请求、启动本地后代，并让每个后代独立消耗。提供方 dashboard 最终会报告聚合 usage，却不能在 Agent 消耗余量前给予引导，也不能阻止由跨越部署预算的响应请求的工具 effect。

记账不得再次计入 fork 复制的历史，必须隔离无关 root，还必须向每个参与 Agent 提供真实的当前引导。只在一个委派工具或一个提供方中强制会被其他 consumer 与 transport 绕过。

## Decision

`@relay-harness/rlh-rollout-budget-controller` 是 opt-in guard 插件，要求显式 `limitTokens` 与 `reminderAtRemainingTokens`。本包与基础 bundle 都不会凭空设定部署开销上限。可选的 `samplingTokenWeight` 与 `prefillTokenWeight` 默认为一，且必须有限并非负。

插件把每个本地 Session 解析到当前最高的 live 持久祖先，并为每个 root id 持有一个进程局部 ledger。它只消费每个 Session 事件序号一次，并忽略低于 `SessionHeader.seedLength` 的 fork prefix。带 usage 的 `assistant/message` 贡献 `max(0, outputTokens) × samplingTokenWeight + max(0, inputTokens) × prefillTokenWeight`；RLH input bucket 已经是未缓存输入，因此排除 cache-read 与 cache-write bucket。

每个 Agent 从自身日志中的持久化插件来源用户消息派生已投递提醒 level。在 pre-step 中，controller 会先委托后续准入 listener，再为新跨越的最大阈值追加至多一条提醒。因此，恢复后的 Agent 不会重复已记录 level，而新后代会在阈值之后的首次请求中收到 root 当前余量。

usage 达到上限时，响应与其记账事件会保留。全局单调工具 guard 会拒绝该响应请求的工具主体。之后每个 Agent pre-step 都会在下一次模型请求前抛出 live code 为 `ROLLOUT_BUDGET_EXCEEDED` 的 `RolloutBudgetError`。没有 Agent 的直接工具执行缺少 root 身份，因此不属于该策略。

每 root 并发准入机制保持独立，由[根会话树 subagent 准入决策](../architecture/2026-08-21-root-tree-subagent-admission.md)负责。容量限制同时存在的 child 生命周期；rollout 预算限制聚合模型 usage。部署可以启用其中任意一项或同时启用。

## Alternatives considered

**扩展 max-token continuation controller。** 不予采用，因为截断 continuation 上限负责一个轮次的输出完成，不负责 input usage、成功响应、sibling Agent 或聚合耗尽后请求的工具。

**把 ledger 放进 `SubagentRuntime`。** 不予采用，因为 root Agent 同样消耗预算，普通 Agent 也可在没有 subagent 能力时存在。Token 记账属于 Agent／session 事件附近；subagent lineage 只提供 parent chain。

**只在 subagent 启动时强制。** 不予采用，因为已准入 child 可以发出许多请求，root 也可在不启动任何 child 的情况下耗尽预算。

**在响应跨越上限时从 `session/event` 抛错。** 不予采用，因为该 feed 是 post-commit、fire-and-forget，并会包含 observer failure。它是观察点，不是 veto。下一个真实 effect 边界是工具 dispatch 与 pre-step。

**立即取消所有 live Agent。** 不予采用，因为取消会丢弃或中止无关的在途输出，还需要新的持久化取消原因。并发响应可以完成并保留；其工具 effect 会被拒绝，下一请求无法开始。

**在第一版持久化进程全局 ledger。** 不予采用，因为正确的跨进程强制需要一个事务存储、身份生命周期与 lease 协议。部分文件写入或逐会话副本会产生 split-brain 预算。opt-in 第一版明确说明进程局部重置。

**把 cache read 按完整 prefill 计费。** 不予采用，因为吸收的先行公式对未缓存 input 加权，而 RLH 已把 `inputTokens` 规范化为该 bucket。再次计入 cache 字段会重复计费。

## Consequences

一个已配置 root 树会获得共享加权 token 记账、逐 Agent 持久提醒、跨越上限响应的工具拒绝，以及后续 sampling 的 fail-closed。无关 root 保持独立。Fork 历史与重新扫描不会抬高总量。

已在途请求可能超过上限，没有本地 usage 事件的远程 subagent backend 也不可见。插件重启还会丢失冷后代总量，直到这些 Session 加载。这些限制会明确呈现，而不是由近似持久化格式掩盖。

live error 事件保留 `ROLLOUT_BUDGET_EXCEEDED`；当前通用 loop 会在持久 `turn/end` fact 中把非提供方 extension throw 记录为 `UNKNOWN`。在通用 extension failure 规范化获得自己的类型化路径前，需要具体 code 的 consumer 使用 live 事件。

真实 Agent-loop 与 Loader-YAML 覆盖固定 root／child 共享、阈值投递、耗尽、fork prefix 排除、重新扫描幂等、缺失祖先、后续拒绝、持久提醒恢复、加权 cache 排除、工具允许／拒绝、无 Agent 工具、fail-loud 配置与 invariant 注册。包源码达到逐文件 100% statement、branch、function 与 line 覆盖。
