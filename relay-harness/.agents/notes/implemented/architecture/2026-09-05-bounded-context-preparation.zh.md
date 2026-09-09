# Agent Note: 有界上下文准备

Status: implemented

[English](2026-09-05-bounded-context-preparation.md) | 中文

## Problem

独立的 Provider timeout 无法限制整次准备耗时。串行 Provider 会累积延迟，而不可用的检索被折叠为缺少 contribution，导致获准步骤的持久 trace 丢失降级信息。

## Decision

[ContextEngine](../../../../packages/context/context-engine/README.md) 拥有整次准备 deadline、可配置的 Provider 并发上限，以及每个注册代际的子取消信号。排队时间消耗总配额。父取消与引擎卸载使准备原子失败；单个注册释放或 timeout 释放逻辑执行槽，并忽略迟到的成功或拒绝。结果在 Provider 完成时脱离其持有对象，再按显式引用优先级与注册顺序打包，不依赖完成顺序。

[Code Context](../../../../packages/context/code-context/README.md) 通过分类的 `ContextProviderError` 报告不可用检索。引擎只记录稳定的 declined、degraded 或 error 原因 token；未知 Provider 异常统一为 `error/provider_failed`。原始 query 与异常文本不进入诊断。非法 contribution 与内部 `ContextEngineError` 仍为致命错误。显式文件上下文缺少必需 `fs`、代码上下文缺少必需 `codeIndex` 时，Provider 抛出 `CONTEXT_ENGINE_INVALID_CONTRIBUTOR`，而非把部署错误降级成没有检索结果。普通的缺少 contribution 仍表示静默 decline，显式分类的 decline 则保留 trace。

## Alternatives considered

- **只缩短局部 timeout** —— 总耗时仍随 Provider 数增长，排队 Provider 也没有共享配额。
- **无界并行检索** —— 大型注册表可能压垮 Provider，并消耗超出调用者需求的资源。
- **把降级检索转成无结果文本** —— 不可用的证据无法证明否定结论。

## Consequences

异步 Provider 工作的准备耗时有界，健康 Provider 无需等待所有慢速同伴才开始运行。引擎无法抢占同步 JavaScript，也无法停止不合作 Provider 的底层 I/O；它发送取消信号并拒绝迟到结果。仅含拒绝的 trace 增加持久元数据，但不增加模型 token。Loader 与 AgentLoop 验收测试以不变的模型输入验证降级和失败检索 trace；定向测试覆盖队列过期、取消、释放、稳定打包和迟到结果隔离。
