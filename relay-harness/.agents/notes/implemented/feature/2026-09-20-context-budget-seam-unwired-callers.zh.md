# Agent Note：Agent step 侧调用方保持 budget seam 不接线

Status: implemented

[English](2026-09-20-context-budget-seam-unwired-callers.md) | 中文

## Problem

请求级 `ContextPrepareInput.limits` 与 `deadlineAt` 字段（[request-local context budget clamps](2026-09-20-request-context-budget-clamps.md)）在 agent STEP 路径上没有调用方：`ReactLoopAgent.preStep` 与 Prompt Enhancement Context Engine 适配器调用 `prepareStep` 时两者都未传递。曾提议接线以让引擎的 caller 侧 seam 获得生产覆盖，但两个调用方都没有可传递的事实：agent loop 全链路不存在 step 墙钟 deadline（`agent-loop` `Config` 无 step 超时、`AgentOptions` 无相关字段、仓库中没有 `stepTimeout`/`turnTimeout` 概念），也没有任何 loop 配置约束 step 上下文规模。step 唯一的取消通道是 abort 信号，而 `prepareStep` 已经接收它。现存的最近预算权威——shipped base 的 `token-budget-controller`——约束的是 turn 结构（`maxStepsPerTurn`、continuation 上限），不是墙钟时间或准备阶段上下文规模。

## Decision

两个调用方保持不接线，并由测试钉住该状态：agent-loop 的 step-context 套件与 prompt-enhancement-context-engine 的 provider 套件断言 `prepareStep` 输入既不含 `limits` 也不含 `deadlineAt`，且 step 行为与之前完全一致。引擎自身经过校验的 `Config` 仍是准备阶段边界的唯一权威——`prepareTimeoutMs` 解析 deadline（`min(engine, caller)` 已把缺失的 caller deadline 折叠为引擎值），`maxChars`/`maxTokens` 解析上限——因此每个部署已经能通过 `context-engine` 配置调节准备阶段，无需第二个旋钮。

`retrieve_context` 保留其 `budget` 字段，其来源是 tool-context 策略 `Config`；该路径不在本次范围内。

## Alternatives considered

**新增 `stepDeadlineMs` loop 配置并转发 `Date.now() + stepDeadlineMs`。** 没有现存消费者或先例需要一个区别于引擎 `prepareTimeoutMs` 的 per-step deadline；新旋钮会把引擎自己的 deadline 复制出第二个事实来源，且一旦设置就改变 loop 行为，违反公开选项的证据规则。

**转发常量上限或固定 deadline"让 seam 有覆盖"。** 伪造常量会歪曲调用方意图，只能静默收紧或谎报预算；而 seam 的覆盖已经存在于真实来源处（tool-context `budget`、memory recall 钳制）。

## Consequences

两个可选字段继续没有 agent-step 调用方；未来 loop 功能若真正持有墙钟预算（例如配置化的 step 超时），可以在交付功能测试的同时删除被钉住的断言来采用 `deadlineAt`。step 路径运行时行为零变化：缺失 deadline 配置时行为逐字节一致，同一断言通过保持完整 step（claim、prepare、模型调用）绿色来守护这一点。

## Verification

`packages/core/agent-loop/tests/step-context.spec.ts`（"supplies no per-request budget ceiling or deadline …"）在记录的 `prepareStep` 输入上断言字段缺失及请求文本不变。`packages/context/prompt-enhancement-context-engine/tests/provider.spec.ts`（"delegates preparation without a caller budget ceiling or deadline …"）对 `prompt_enhancement` purpose 做同样断言。`vitest run packages/core/agent-loop packages/context/prompt-enhancement-context-engine packages/context/context-engine` 全绿，两个涉改包 `tsc -b` 通过。
