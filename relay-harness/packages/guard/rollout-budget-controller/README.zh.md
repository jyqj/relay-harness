# @deepseek-ai/dsh-rollout-budget-controller

[English](README.md) | 中文

这是一个 opt-in 的共享 rollout 预算，覆盖一个 root Agent 及其所有本地后代。它不是工具。插件会对每个自身 suffix 的 `assistant/message.usage` 只统计一次，使用可配置权重计费输出与未缓存输入，在每个 Agent 的下一次模型请求中插入阈值提醒，在耗尽后拒绝后续 pre-step，并拒绝由跨越上限的响应请求的工具 effect。

该 controller 与 [`dsh-token-budget-controller`](../token-budget-controller/README.md) 相互独立：后者会在单次请求触及 `max-tokens` 后继续一条响应；本包限制跨多个请求与 subagent 的聚合模型开销。

## 配置

本包与基础 bundle 都不会凭空设定上限。加载它的部署必须选择预算与提醒阈值：

```yaml
- id: rollout-budget-controller
  name: '@deepseek-ai/dsh-rollout-budget-controller'
  config:
    limitTokens: 200000
    reminderAtRemainingTokens: [50000, 20000, 5000]
    samplingTokenWeight: 1 # default
    prefillTokenWeight: 1  # default
```

`limitTokens` 必须是正 safe integer。每个提醒阈值都必须是严格低于上限的正 safe integer。权重必须有限且非负。Loader 校验与直接 `apply()` 边界都会对无效值 fail loud。

## 记账与强制

当前最高的 live 持久祖先是记账 root。root 会话与每个本地 child／grandchild 都解析到同一个进程局部 ledger；无关 root 保持隔离。Fork seed 不会重复计费：低于 `SessionHeader.seedLength` 的事件属于祖先已统计的 prefix，而每个会话自身 suffix 会按事件序号消费一次。因此，重新扫描 live 或已恢复 Session 不会重复 usage。

加权 usage 为 `outputTokens × samplingTokenWeight + inputTokens × prefillTokenWeight`。DSH 把 `inputTokens` 定义为未缓存输入，因此刻意不计 `cacheReadTokens` 与 `cacheWriteTokens`。提供方报告的负 bucket 会钳制到零。

耗尽会在下一个 effect 边界 fail closed。跨越上限的响应会保留。该响应中的任何工具调用都会到达全局单调工具 guard，并在不调用主体的情况下以拒绝结算；之后任何 Agent pre-step 都会在下一次模型请求前抛出 `RolloutBudgetError`（`ROLLOUT_BUDGET_EXCEEDED`）。没有 Agent 的直接工具执行缺少 root 身份，因此不属于该策略。

阈值根据共享的剩余加权 token 计算。每个 Agent 会在下一次进入的 pre-step 中收到每个已跨越 level 一次。提醒是持久化的插件来源用户消息；恢复后的 Agent 会扫描自身日志，不会重复已记录 level。若两次请求间跨越多个 level，只生成一条携带当前剩余量的提醒。

设计理由与未采用的强制位置记录在[共享 rollout 预算 Agent Note](../../../.agents/notes/implemented/feature/2026-08-21-shared-root-rollout-budget.md)中。

## 模型体验

### 剩余预算提醒

#### 模型看到的内容

每个请求最多新增一条提醒；对该 Agent 而言，每个已跨越配置阈值只出现一次。

##### 提醒

```markdown
You have <remaining> weighted tokens left in the shared root-session rollout budget.
```

#### Token 影响

每个活跃 Agent、每个跨越 level 一条短用户消息。读取提醒的模型调用也参与记账；首个阈值前与耗尽后不会产生提醒。

#### KV 缓存影响

在每个 Agent Session 中仅追加。提醒位于可复用请求 prefix 之后，不会使较早 KV-cache 条目失效。

## 已知限制与后续工作

- **进程局部聚合** —— 插件重启会重置跨会话 ledger。已加载 Session 会重新扫描且不重复，但只存在于冷后代 Session 中的 usage 要等其加载后才可见。持久化跨进程预算需要一个持久化事务与 lease owner。
- **只统计本地会话 usage** —— 不向本地 child Session 追加模型 usage 的进程外 subagent 提供方不会被计费。用提供方中立的已验证 usage 扩展 `SubagentResult`，要求每个远程协议都能提供等价事实。
- **并发超额** —— 已在途模型调用可能在另一调用跨越上限后全部完成并报告 usage。它们后续的工具会被拒绝，但记账总量可能超过配置上限。
- **以 adapter 上报为准** —— 错误或缺失的 `assistant/message.usage` 无法精确重建。缺失 usage 贡献为零；负 input／output bucket 会钳制到零。
- **live 错误与持久化规范化** —— live `agent/error` 携带 `RolloutBudgetError` 及其稳定 code。通用 Agent loop 当前会在 `turn/end` 中把非提供方 extension throw 记录为 `UNKNOWN`；需要具体 code 的 host 使用 live error 事件。
