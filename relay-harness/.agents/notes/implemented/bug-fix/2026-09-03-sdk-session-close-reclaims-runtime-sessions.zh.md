# Agent Note: SDK session/close 回收运行时会话

Status: implemented

[English](2026-09-03-sdk-session-close-reclaims-runtime-sessions.md) | 中文

## Problem

SDK 运行时协议没有任何退役会话的途径：`HarnessSdkJsonRpcServer` 的 sessions map 从首次提示词起持有每个 `AgentHandle` 直到进程关闭，因此每次在自动铸造会话 id 上的 `RelayHarness.run()` 都泄漏一个活 agent——它的循环、内存会话与持续增长的会话日志——贯穿运行时进程整个生命周期。每次 `run()` 铸造的全新 `session-<uuid>` id 调用方永远无法再引用，却没有任何东西回收它。泄漏量只受部署执行的 run 次数约束。

## Decision

协议新增一个 client→server 请求 `session/close`，参数为 `SessionCloseParams { sessionId }`。服务器的 `closeSession` 从 sessions map 删除记录并 dispose 句柄；未知 id 以 JSON-RPC 错误应答（`unknown session: <id>`）而不是读作成功，关闭后的 id 再次提示词会经既有创建路径生成全新会话。

TypeScript 客户端暴露 `HarnessClient.closeSession(sessionId)` 并接入 `RelayHarness.run()`：自动铸造会话上的 run 在结束时经 `finally` 关闭该会话，命名会话保持调用方所有直到 `close()`。命名会话行为与之前逐字节一致。`RunResult` 同时新增 `finishReason`——该区间最后一次 `turn/end` 的 `reason.kind`，没有轮次结束时为 `null`——补齐与 Python SDK（早已上报）之间的投影差距；`turn/end` 的 reason kind 不是字符串时以 `SdkProtocolError` 拒绝。Python SDK 在其对应的变更中镜像 `session_close`。

`HarnessClient.performClose` 现在即使在从未 spawn 子进程时也会 fail 全部订阅：`start()` 之前创建的订阅在 `close()` 之后没有任何生产者，让它的 `next()` 永久挂起违反了文档化的 "after close, rejects immediately" 契约。fail 保持首错优先且幂等，因此不会干扰既有运行时死亡路径。

## Alternatives considered

**在服务器上做会话引用计数加空闲超时。** 否决，因为会话生命周期是调用方的决定：只有客户端知道一个 id 是否还会复用，超时要么关闭调用方仍需要的会话（静默丢失工作），要么引入一个与显式关闭重复的可配置项。

**首个提示词前不铸造会话，每个客户端复用一个 id。** 否决，因为它改变每个消费方可观察的会话身份（转录、血缘、subagent 树都以 id 为键），且无法表达同一运行时上的两个并发会话。

**finishReason 只通过新方法返回。** 否决，因为 `RunResult` 是两个 SDK 共同投影的自有运行结果面；旁路方法会让 TypeScript 结果永久弱于其 Python 孪生。

## Consequences

经 `RelayHarness.run()` 执行 N 次提示词的部署，最后一次 run 之后保留的 agent 数从 N 变为 0；只有命名会话累积，其数量按构造对调用方可见。曾通过 `harness.session()`（不带命名 id）持有 `HarnessSession`、并期望其上的 `run()` 之后运行时 agent 继续存活的调用方，会看到 agent 被 dispose——没有已发布的消费方能引用一个调用方未知的 uuid，因此爆炸半径仅限此类投机持有。对调用方从未创建的 id 做 `session/close` 现在响亮失败，而此前协议根本没有这个方法。协议方法集从三对请求/结果增至四对；示例快照只钉 `sessionId` 与 `finalResponse`，预期输出无需变化。
