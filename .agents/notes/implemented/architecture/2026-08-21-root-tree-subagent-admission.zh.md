# Agent Note: 根会话树 subagent 准入

Status: implemented

[English](2026-08-21-root-tree-subagent-admission.md) | 中文

## Problem

各 subagent 提供方可以独立启动，每个 consumer 也可通过同一服务 fan-out，但服务没有共享容量。提供方局部上限无法协调 spawn、fork、remote、workflow 与 team 路径，而只在工具层设限会被直接服务调用绕过。因此，递归委派可能在没有根会话上限的情况下成倍增加活跃 child 生命周期。

容量 slot 还需要一个正确释放点。结果结算过早，因为一次性 run 仍可能持有资源，而可继续 child 根本没有 run 结果。在静默 disposal 前释放会让替代工作进入，即使前一个 child 仍持有 Agent、进程、transport 或后代 forest。

## Decision

`SubagentRuntime` 持有一个由普通 `start()` 与每次可继续物化共用的 `SubagentAdmissionController`。workflow 与 team 也通过同一服务委派，因此无需面向 consumer 的专门集成就会进入同一张表。controller 解析直属 parent 当前最高的 live 持久祖先，并把 child 同时计入该 root 与直属 parent id。不同 root 的状态彼此独立。

`maxActivePerRoot` 与 `maxActivePerParent` 是可选正数配置。省略即表示该 scope 无界，使 Service Definition 继续作为可复用的组合原语。发布的基础 bundle 设置 `maxActivePerRoot: 4` 与 `overflow: reject`，沿用 Codex multi-agent v2 的四 thread 默认值，同时把上限应用到 DSH 与 transport 无关的 child 生命周期。容量饱和会在提供方启动或 Agent 物化前以 `CAPACITY_EXCEEDED` 拒绝。

`overflow: queue` 是显式的替代部署策略。每个 root 持有一个队列；提升会选择同时满足 root 与直属 parent 上限的最早 waiter，因此某个达到 sibling 上限的 parent 不会阻塞另一个合格 sibling parent。调用方取消会移除 waiter。runtime 关闭会拒绝排队与未来获取，但不会撤销已发布 child。

一次性准入会转交给返回的 `SubagentRun`；其幂等 wrapper 只在提供方 `dispose()` 尝试结算后释放。提供方启动拒绝会立即释放。可继续准入会转交给 Activation，并在未发布回滚或完整 Activation handle disposal 后、完成 child-first teardown 与静默后释放。每次释放都幂等，并可提升排队工作。

## Alternatives considered

**只限制面向模型的委派工具。** 不予采用，因为 workflow、team、直接服务 consumer 与未来 adapter 都能在不经过该工具的情况下调用 `ctx.subagents`。

**让各提供方自行持有容量。** 不予采用，因为同时存在的 spawn、fork 与 remote child 会占用独立池，突破一个 root 的预期上限。

**只在 Agent loop 中统计活跃模型轮次。** 不予采用，因为 remote 提供方工作与非模型 child 资源会在该状态之外继续活跃，而把 subagent policy 加进通用 loop 会倒置能力所有权。

**在 `result` 或生命周期结束时释放。** 不予采用，因为观察可以先于 holder 所有的清理结算，而可继续 Activation 既没有 run 结果，也没有 holder。

**使用一个进程全局上限。** 不予采用，因为无关用户 root 会互相饥饿。root 局部计数器既保留隔离，也限制递归 fan-out。

**默认排队。** 不予采用，因为嵌套调用方可能在占用一个 root slot 的同时等待另一个 slot，使进展依赖无关 child 释放。立即拒绝会给模型确定的容量错误；偏好 backpressure 的部署可以选择带调用方取消的排队模式。

## Consequences

基础组合在一棵完整 root 树内最多准入四个同时存在的一次性 run 与可继续 Activation 生命周期，不受提供方或 consumer 影响。第五次启动会在外部工作前失败。直接组合若未选择上限则保持无界，不同 root 绝不共享 slot。

容量会跟随清理，而不是可见完成。若一次性 consumer 违反既有要求、未 dispose 每个返回 run，它也会保留容量，使所有权泄漏变得可观察，而不是静默超额。即使 handle 清理报告错误，可继续回滚与 teardown 仍会释放，避免失败清理记录永久饿死 root。

如果调用方没有提供有效取消且没有已准入生命周期释放，队列模式可能无限等待。它保持 opt-in；manager 与 runtime teardown 会关闭准入并拒绝待处理工作。

单元覆盖固定 root 隔离、sibling 上限、合格提升、取消竞态、关闭行为与幂等释放。服务覆盖固定共享祖先、提供方启动回滚、一次性 disposal 所有权，以及 Activation 静默后的可继续释放。
