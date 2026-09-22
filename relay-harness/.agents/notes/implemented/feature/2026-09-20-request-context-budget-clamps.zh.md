# Agent Note: 请求级上下文预算收紧

Status: implemented

[English](2026-09-20-request-context-budget-clamps.md) | 中文

## Problem

部署侧的上下文预算（`ContextEngine` 配置）只约束引擎的打包结果，调用方无法为单次请求声明更小的配额，也没有随步骤传递的墙钟 deadline。有效上下文预算因此可能超出请求方真正想要或仍能承受的范围。memory recall Consumer 只按自身配置上限渲染：较大的请求配额会让召回超出调用方预算，而装不下的命中被静默描述为"没有记忆"，而不是一次有分类的预算拒绝。

## Decision

`ContextPrepareInput` 接受可选的 `limits`（`Partial<ContextBudget>`）与 `deadlineAt`。规划时总配额取部署配置、请求 `limits` 与（显式检索时的）retrieval budget 三者的最小值；`limits` 与 `budget` 只能降低部署值，不能抬高，非法（非正或非整数）的 `limits` 在任何 Provider 运行前以 `CONTEXT_ENGINE_INVALID_CONFIG` 失败。整次准备 deadline 取 `prepareTimeoutMs` 与 `deadlineAt` 的较早者；每个合格 Provider 已按 `budget.timeoutMs: max(0, deadlineAt - now)` 与绝对 `budget.deadlineAt` 收到预算，调用方 deadline 原样传播到每个 Provider 预算。

memory recall Consumer 将渲染配额收紧为 `min(maxContextChars, budget.maxChars, max(0, (budget.maxTokens - 4) * 4))`——部署上限再被请求的字符与估算 token 预算收紧，并预留框架开销。当存在命中但剩余配额装不下任何一条（包括连框架都装不下）时，contributor 以 `ContextProviderError('declined', 'budget_exhausted')` 拒绝，引擎将其记录为拒绝 trace 而非静默的"无记忆"；真正的空搜索仍按原样无理由拒绝。

## Alternatives considered

**在每个 contributor 上各自实现请求预算字段。** 各 Consumer 自行推导收紧规则必然漂移；总配额解析由引擎统一负责一次，contributor 只在其上进一步收紧。

**当 `limits` 更大时抬高部署预算。** 已否决：请求永远不会比部署配置更可信；收紧按设计是单向的。

**静默丢弃装不下的召回命中（原行为）。** 调用方无法区分"没有记忆"与"记忆装不下"，缺失的 `budget_exhausted` 分类让 trace 看不到真实的预算压力。

## Consequences

传入 `limits` 的调用方得到严格更小或相等的预算；省略新字段的既有调用方行为不变，唯一例外是在紧张的请求预算下，memory recall 消息可能小于 `maxContextChars`，且超尺寸命中的召回请求会以 `declined/budget_exhausted` 决策浮出，而非悄然省略。调用方 deadline 短于 `prepareTimeoutMs` 可能让本可完成的 Provider 被饿死；trace 与配置超时一样记录 `deadline`。

## Verification

`packages/context/context-engine/tests/native-retrieval.spec.ts` 固定 purpose 排除、单 Provider 跨候选的聚合扣费、同 rank 的稳定身份排序、limits 降低／不可抬高／非法拒绝，以及 deadline 传播与已过期 deadline。`packages/memory` 测试覆盖召回渲染与结算；两个引用已移除的 `session-query`／`memory-extractor-llm` 深层路径的 code-context 套件在基线分支即失败，与本变更无关。
