# Agent Note: SDK close 路径获得真实运行时 wire 覆盖

Status: implemented

[English](2026-09-03-sdk-close-real-runtime-coverage.md) | 中文

## Problem

R5 的 session/close 路径只在进程内对着 fake handle（`server.spec.ts`）与脚本化 fake runtime（`fake-runtime.ts`、Python fake peers）上被验证过。没有任何 harness 启动真实的 `rlh-jsonrpc-agent` 运行时并在线上关闭一个会话，因此该方法存在的目的——dispose 静默、会话日志落盘、teardown 顺序——在两侧 SDK 上都未被证明。prompt 后立即 close 的情形在任何地方都没有覆盖。同一条缝上，两侧 SDK 的 keyless 期望输出都没有钉住 R5 的头号 parity 字段 `finishReason`/`finish_reason`；两处文档描述了并不存在的 wire 行为：`SdkProtocolError` 的示例声称 `session/prompt` 响应会校验 `accepted: true`，而实际校验读取的是 `messageId`；fake-runtime 的注释重复了同样的说法。

## Decision

TypeScript 快照 harness（`examples/jsonrpc-agent/tests/sdk.snapshot.ts`）的 `normalizeResult` 现在投影 `finishReason`，已提交的 `result.expected.json` 钉住该字段。公共的 `openRuntime` 从 `runScenario` 中抽出 env/launch 组装，close-path describe 在 replay 模式下运行以下真实运行时探针：

- `close-auto-session` 在不带 session id 的情况下运行 `RelayHarness.run()` 并证明自动回收：对铸造出的 id 再次 `closeSession` 以 `unknown session` 拒绝，且按身份绑定的读取确认该确切完成轮次已进入持久日志。
- `close-named-session` 关闭一个显式命名的会话，证明 id 已释放（第二次 close 拒绝），并证明被关 id 的持久日志完好。
- `close-mid-turn` 用一个含单个 `hang` entry 的 `replay.override.json` sidecar 把 close 门控在首个流式 `assistant/chunk` 上（该 entry 一直停顿直到被取消），随后断言客户端观察到 `turn/end { kind: 'aborted' }` 与终态 idle，且持久日志以 aborted turn 收尾。

- `close-reprompt` 关闭后续接同一持久身份，断言第二轮精确回答、编号递增以及第一轮字节前缀保留。
- `close-pending` 在请求尚未产出首个 chunk 时关闭，按流中结束事件的精确身份确认持久化的取消结果。

Python 冒烟（`scripts/smoke-python-runtime.py`）新增 `sdk-close` 场景（需要 exe，包含在 `--scenario all` 中），用 mock model 镜像自动、具名与轮中关闭探针：auto-close 探针再次关闭铸造 id 并期望 `JsonRpcError: unknown session`，named 探针显式关闭后再次关闭，mid-turn 探针在 mock 流首个 chunk 后的暂停期内 close，随后断言 SDK 自己的 `finish_reason` 投影在终态 idle 时报告 `aborted`。mock handler 流式发出探针的前两个 chunk、flush、暂停、再继续，并容忍被中止 turn 遗弃的连接产生的 `BrokenPipeError`。`build_snapshot_files` 在 advanced `result.json` 中钉住 `finish_reason`，并在同一次变更中重录。过期的 `accepted: true` 文档声明改写为真实的 `messageId` 校验。

## 发现的缺陷（不在本次变更范围内）

在真实运行时上驱动 close 路径暴露了两个本 slice 选择绕开而非修复的行为，因为两者的修复都落在 slice 之外的文件里：

1. **对已关闭 id 再次 prompt 违反了文档承诺的 fresh-session 契约。** `session/close` 之后，对同一 id 的 prompt 被接受并运行，但新会话在持久化协调器中与磁盘日志冲突（`adoptLivePrefix` → 空 seed 使 `seedCoversPrefix` 失败），turn 以携带 `session "X" already has a persisted log on disk ... (id collision)` 的 `turn/end { kind: 'error' }` 结束。新会话的任何事件都不落盘，且是静默的。server 契约与 SDK client JSDoc 都承诺"对已关闭 id 的后续 prompt 会创建全新会话"。后续修复要么把重建路由到 resume 路径，要么把冲突守卫收窄到并发生命周期；探针 fixture 刻意不钉住这个坏结果。
2. **在首个流式 chunk 之前 close 会跳过 `turn/end`。** 流中途 close（观察到首个 chunk 后 close）确定性地产生 `turn/end { kind: 'aborted' }`；而在模型请求仍挂起（响应尚未开始）时 close 只发布终态 idle，完全没有 `turn/end`。两个取消窗口在线上词汇不一致；R5 的进程内验证覆盖的是流中途窗口。

运维备注：已提交的 `dist-exe` 产物早于 `session/close`，会回答 `unknown Relay Harness SDK runtime method`；从当前 `lib/` 重新打包（`pnpm exec tsx scripts/build-exe-for-python-sdk.ts --skip-build`）恢复了 Python 冒烟所需的 exe。

每个正常完成的关闭探针都把持久化屏障绑定到 SDK 本轮真实的 Session id、Turn 编号、结束事件 seq、assistant 消息 id 与 seq，以及精确回答。自动和具名关闭分别证明身份释放与对应后台批写已持久化。再次提示恢复同一持久身份：第二轮编号递增，第一轮日志逐字节保留为前缀，并精确存储先后的 `SDK snapshot OK` 与 `SDK re-prompt OK`。取消探针也等待流中观测到的确切 turn/end，而不是任意相同结束原因。真实文件延迟追加回归在磁盘仍只有第一轮 completed 尾部时等待第二轮回答，证明旧 completed 不能满足新屏障。快照 normalizer 与 golden 比较保持不变。

## Alternatives considered

**像 turn 场景一样对 close 场景的通知流做快照。** 对再 prompt 探针而言被否决（会把缺陷 1 钉进契约），对其余场景也不必要：探针确定性地断言 close 契约的行为（释放、日志完好、aborted 结尾），而 turn 场景已经钉住了流词汇。

**用 paced replay（`paceMs`）代替 hang override 门控 mid-turn close。** 被否决因为 pacing 是时序旋钮——足够快的机器仍可能在 close 到达前完成 turn——而 `hang` entry 使 abort 成为流结束的唯一途径。

**通过对铸造 id 再 prompt 来证明 auto-close。** 因缺陷 1 被否决；re-close（`unknown session`）断言在不触碰持久化冲突的前提下证明了所有权释放。

## Consequences

close 路径、abort 词汇或两侧 SDK turn-ending 投影的回归，现在会在两侧的 keyless 套件中失败。已提交的期望输出把 `finishReason`/`finish_reason` 与 `finalResponse` 并列钉住。两个发现的缺陷现已闭合——close 后再 prompt 契约经 SDK server 的 resume 路径修复，请求挂起期的取消窗口在当前 agent-loop 上已不再复现——并在单元、replay 条目与真实 runtime 三层都有回归探针（[sdk-close-reprompt-resume](../bug-fix/2026-09-03-sdk-close-reprompt-resume.md)）。
