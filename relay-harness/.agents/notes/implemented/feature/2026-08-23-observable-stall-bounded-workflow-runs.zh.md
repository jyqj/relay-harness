# Agent Note: 可观测且具停滞上限的 workflow run

Status: implemented

[English](2026-08-23-observable-stall-bounded-workflow-runs.md) | 中文

## Problem

workflow 事件流已经公开足够事实，可供外部构建进度视图，但服务本身没有可查询的活动运行投影。每个运维集成都必须通过监听器重新构建顺序、phase 与子 agent 计数；较早运行仍存活时，同一持久运行身份还可能再次启动。模型编写的 workflow 或远程子 agent 也可能无限期静默；持有方发起的取消有时间上限，但无人值守部署没有可选的静默期限。

## Decision

`WorkflowEngine` 拥有一份进程内活动运行表，事实来自它发出的同一组 `workflow/*` 事件。`workflow/start` 插入一个 `WorkflowActiveRunSnapshot`；phase、log 与子 agent 生命周期事件推进其 `lastProgressAt` 和计数；`workflow/end` 在 end 监听器运行前移除它。`activeRuns()` 按启动顺序返回分离值，不公开活动句柄。`assertWorkflowRunAvailable()` 把未配对的重复 start 转为同步 `RUN_ACTIVE` 失败；worker-thread 提供方会在访问 journal 或构建 worker 前执行该检查。

`WorkerThreadWorkflowEngine.Config.stallTimeoutMs` 是非负部署设置，默认值为 `0`。正值会启动一个由运行拥有的 watchdog，并在每条被接受的双向宿主／worker 协议消息后重新计时，其中包括子 agent 发布与终态结果转发。超时会原子地接管 error outcome，关闭后续协议接纳，中止并 dispose 子 agent，为滞留的子 agent 生命周期事件配对，并终止 worker。已接受的取消会解除 watchdog，使既有取消宽限期继续作为唯一取消期限。

这些机制以 clean-room 方式吸收 Symphony 的单 owner runtime snapshot 与基于最后进展的停滞协调。Workflow 包不引入 tracker adapter、Codex app-server client、workspace 生命周期实现或 Elixir 源码。后续的[持久化 Issue Automation](2026-08-23-durable-issue-automation.md)决策把这些部署关注点实现为独立 opt-in capability seam，而不是扩展该引擎。

## Alternatives considered

**把 Symphony 的 Tracker Orchestrator 复制进 Workflow 或 Agent Loop。** 不予采用，因为 Issue polling、Provider 原生 ticket 写入与 per-issue checkout 策略都属于部署关注点。把它们折叠进 `agent-loop` 或 `workflow-worker-thread` 会重复 DSH 的 Session、Subagent、Schedule 与 Workspace 所有权；后续 opt-in Automation Layer 保持了这一分离。

**从服务公开活动 `WorkflowRun` 对象。** 不予采用，因为观察者会因此取得取消与 dispose 权限。分离事实保留既有的持有方所有权。

**持久化活动运行快照。** 不予采用，因为进程重启无法复活 worker thread 或任意脚本状态。既有 workflow journal 会恢复已完成 host call；把它的行展示为活动执行会产生错误事实。

**默认启用固定 watchdog。** 不予采用，因为 DSH 没有适用于所有远程子 agent 静默工作的统一上限。部署需显式设置大于最长预期协议静默时间的期限。

**只在模型可见叙述后重置。** 不予采用，因为即使 workflow 没有发出 phase 或 log，子 agent 发布、结果转发与 dispose acknowledgement 也属于真实进展。

## Verification

workflow Service Definition 测试固定启动顺序投影、时间戳、phase 与子 agent 计数、嵌套 meta 分离、重复 id 拒绝及结束时移除。worker-thread 集成测试固定可选静默超时会产生 error、活动投影移除与有界 dispose；既有长时间运行取消用例固定默认禁用行为不变。Typecheck、生成的 Cordis/config catalog、双语配对与文档 gate 覆盖公开方法和配置字段。

## Consequences

运维代码可以查询当前 workflow 事实，而无需与监听器安装竞态，也不会取得运行控制权；持久 resume id 不能在同一引擎内并发运行。无人值守部署可以终止静默 workflow；交互式与长时间运行部署只需保持 watchdog 禁用，即可保留既有行为。

该投影位于进程内，不是持久调度器。`lastProgressAt` 记录被接受的 workflow 生命周期事件，而 watchdog 还把私有宿主／worker 协议流量视作进展；因此运维时间戳刻意表示面向模型的进度视图，而非 watchdog 的私有计时样本。配置的超时若短于合法子 agent 静默时间，将会终止有用工作，因此提供方 README 明确记录这项部署权衡。
