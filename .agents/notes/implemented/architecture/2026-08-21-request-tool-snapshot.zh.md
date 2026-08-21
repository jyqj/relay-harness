# Agent Note: 请求级工具快照

Status: implemented

[English](2026-08-21-request-tool-snapshot.md) | 中文

## Problem

提示词组装与工具执行会在不同时间读取带 scope 的工具注册表。模型流式输出期间，Cordis 注册可能卸载或被替换，导致同一请求先声明一种 schema，随后却执行另一份定义、改变并发分类，或返回 `UNKNOWN_TOOL`。Code Mode 的生成 SDK、已选代码后端、binding 目录与嵌套分派调度器之间也存在同样的时间分裂。

最终 `system-prompt/assemble` 结果具有权威性。监听器可能有意移除一项 schema，因此只在 waterfall 前冻结注册表，仍会让执行绕过最终模型可见请求。

## Decision

默认 agent loop 会在每次提示词组装前捕获一个 `ToolRequestSnapshot`。该快照持有解析后的 scope 工具定义、呈现模式、已分离的 wire schema、Code Mode SDK schema 与文本，以及已选代码 runtime 的强引用。它通过 symbol key 的组装上下文贡献这些 schema，再把模型直接执行绑定到 waterfall 后 `PromptAssembly` 中的工具名称。监听器新增但没有捕获定义的名称仍不可执行；被移除的名称即使捕获时存在定义，也会被拒绝。

快照暴露一个 staged scheduler，其 prepare 路径会把已选定义记录到每个 `ToolRunContext`。分派、输出校验、渲染、post-policy 值替换，以及 wrapper 生成的成功结果规范化，都使用该记录定义，不再重新解析实时注册表。直接 `ctx.tools.execute()` 调用也会在准入时执行同样的逐执行定义捕获。实时 pre／around／post policy、审批、guard 与取消保持实时：安全策略变更可以立即拒绝在途请求，但不会替换该请求已声明的实现。

Code Mode 继承外层执行的快照。因此，其生成 SDK、后端、binding 名称、分类器与嵌套调度器使用同一捕获视图；注册表或后端替换只影响下一次模型请求。快照会让定义与后端对象保持存活，直到步骤结算，并在拒绝、空步骤、失败、取消、普通完成与工具结算的所有路径释放。注册项 disposal 会立即从后续捕获中移除工具，但不能改写已接受请求。

该机制只供 `dsh-tools` 与 `dsh-agent-loop` 内部协作：`TOOL_RUNTIME_REQUESTS`、`TOOL_REQUEST_SNAPSHOT` 与绑定快照的 scheduler 是 symbol key 的集成点，不是插件扩展 surface。普通检查调用方看到的公开注册表 API 仍是当前实时目录。

## Alternatives considered

**在每次启动前继续重新解析。** 不予采用，因为实时重分类会让请求执行模型从未收到的定义与输出约定。HMR 响应速度不值得破坏请求身份。

**把 hook、审批、guard 与所有 policy 连同定义一起冻结。** 不予采用，因为安全策略必须能够在捕获后拒绝在途请求。快照冻结的是能力身份，而不是授权决定。

**阻止整个 Cordis fiber teardown，直到全部捕获请求结束。** 不予采用，因为无关 effect disposal 可能正是工具等待的操作，从而形成 teardown 死锁。强引用会保留定义与后端身份；提供方若独立关闭外部资源，可能使捕获工具失败，但不能把调用转交给替代实现。

**信任 waterfall 前的 schema 集合。** 不予采用，因为 `system-prompt/assemble` 具有权威性，并可能有意移除工具。快照会在该 waterfall 后绑定直接执行。

## Consequences

一次模型请求现在会在提示词生成、provider streaming、原生调度、Code Mode、结果规范化与最终化期间保持同一个工具能力身份。HMR 变更从下一步骤起可见，而不会进入当前步骤中途。这从 scheduler 约定中移除了实时注册表重分类，以即时替换换取确定性的请求行为。

快照会在一个步骤期间保留定义与后端对象。它不会保留提供方独立关闭的任意外部资源；这类 teardown 会表现为捕获实现失败，而不是静默执行新实现。最终组装监听器若在不改名的情况下重写 schema，仍负责让该 schema 与捕获定义的校验器和输出约定保持兼容。

