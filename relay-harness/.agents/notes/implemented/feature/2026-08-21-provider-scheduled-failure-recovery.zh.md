# Agent Note: 提供方定时失败恢复

Status: implemented

[English](2026-08-21-provider-scheduled-failure-recovery.md) | 中文

## Problem

请求失败恢复存在三个精度缺口。第一，分类逻辑内联在 `dsh-llm-retry` 中：插件从原始 `LlmFailure` 字段自行推导"是否可按等待恢复"，任何未来的恢复策略（凭证池、提供方降级）都不得不重复这份推导。第二，超过 `maxDelayMs`（默认 10 秒）的提供方命名恢复时间在 normal mode 被直接放弃、在 always mode 被钳制到本地退避——分钟级限流重置这一最常见的定时恢复信号恰好落入该缺口。第三，`QUOTA` 被一概视为终态：周期性配额重置（提供方给出重置时间）明明按定义可恢复，却无法通过等待恢复，而余额耗尽（无命名时间）才是真正终态。

## Decision

`dsh-llm` 拥有统一的结构化分类 `classifyLlmFailure`，把规范化后的 `LlmFailure` 折叠为四种恢复类别之一：`local-retryable`（瞬态错误码，本地等待）、`provider-scheduled`（提供方命名了恢复时间——最强信号，优先于错误码分类）、`context-overflow`（靠 compaction 恢复，绝不靠等待）、`terminal`。上下文溢出优先于命名延迟；命名延迟优先于错误码。`dsh-llm-retry` 改为消费该分类，不再自行推导。

重试策略新增两个经校验的字段。`backoff.maxProviderDelayMs`（默认 60 秒，必须 ≥ `maxDelayMs`）是执行器完整等待的最大提供方命名延迟；超出它时 normal mode 委托、always mode 回退本地退避，保留原有逃生通道。normal mode 的 `scheduledCodes`（默认为空）让额外错误码仅在提供方命名恢复时间时才有资格重试——周期性 `QUOTA` 重置由此可按等待恢复，而不带延迟的 `QUOTA` 仍是终态。两个字段都进入规范策略 key，策略变更即开启新的重试历史。

## Alternatives considered

- **把提供方错误细分为更多错误码**（`QUOTA_PERIODIC`、`RATE_LIMIT_EXTENDED`）。区分依据——命名恢复时间——已经由 `LlmFailure.providerRetryAfterMs` 携带；新增错误码会与之重复，并迫使每个消费方学习更大的分类体系。
- **完整等待任意长的提供方延迟。** 提供方可能把 agent 钉住数小时；上限保留了逃生通道，always mode 也保住其不可终止保证。
- **`scheduledCodes` 默认设为 `['QUOTA']`。** 目前没有生产证据表明已部署提供方会给出配额重置时间；该字段以 opt-in 形式发布，一旦有证据，启用只需一行提供方配置。

## Verification

`dsh-llm` 单元测试固定分类优先级（溢出优先于延迟、延迟优先于错误码、瞬态集合、非法延迟拒绝、终态类别）以及两个新字段的策略解析与校验。`dsh-llm-retry` 循环测试证明：30 秒提供方延迟被完整等待（此前直接放弃）；超上限延迟仍然委托（normal）或使用本地退避（always）；定时 `QUOTA` 仅在提供方命名延迟时重试，裸 `QUOTA` 仍为终态。

## Consequences

分钟级提供方重置现在能够恢复，而不是首次尝试即失败；周期性与终态配额的区分无需新增错误码即可表达。分类有了唯一归属，未来的凭证池或提供方降级策略将基于同一组类别路由，而不是重复推导。默认策略 key 形态变化，旧日志的重试历史不再延续——在预发布立场下可接受。
