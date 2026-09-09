# Agent Note: A re-prompt for a released SDK session id resumes its durable log

Status: implemented

[English](2026-09-03-sdk-close-reprompt-resume.md) | 中文

## Problem

SDK close 契约覆盖的 Agent Note（[sdk-close-real-runtime-coverage](../testing/2026-09-03-sdk-close-real-runtime-coverage.md)）记录了两个其探测只能绕开的缺陷。对已关闭 session id 的再次 prompt 会被 SDK server 接受，却在持久化协调器处失败：新建的空 session 与该 id 的持久日志冲突（`adoptLivePrefix` → `seedCoversPrefix`），该 turn 以携带 `(id collision)` 的 `turn/end { kind: 'error' }` 结束，且新 session 没有任何内容落盘。而 close 契约承诺"对该 id 的后续 prompt 会创建一个全新 session"，文档化的流程因此断裂。第二个缺陷——首块流式输出前的 close 不产生 `turn/end`——在当前 agent-loop 上已无法复现：首块之前窗口内的 disposed-cause cancel 已经会追加终止性的 `turn/end { kind: 'aborted' }`，在循环层与真实 runtime 上皆然。

## Decision

`HarnessSdkJsonRpcServer.createSession` 通过 agent registry 的 `resume` 路径重新挂接已释放的 id，而不是总是调用 `create`：先尝试 `agents.resume`，当该身份没有可恢复的持久日志时（首次使用、首次 append 之前就关闭的生命周期、或未配置持久化服务的部署）回退到 `agents.create`。session id 就是持久化身份，因此在已释放 id 上构造的全新 session 既无法采纳存储日志（已构造的 Session 无法事后补种，且协调器自身的 create 路径拒绝同一 id 出现第二份 artifact），也无法替换它（两个第一方后端都拒绝在既有日志上物化）。在不引入破坏性后端重置的前提下，resume 是唯一能恢复契约的方向，并且与同一调用者在进程内已经看到的行为一致：对同一命名 id 的两次 `run()` 会延续对话，因此 close 后再次 prompt 也应延续。真实的加载失败（损坏、后端错误）会经由回退 create 的持久化探测重新浮出——该探测会拒绝同一身份——所以回退只吞掉"无日志"这一种情形。

对于 pending-close 窗口，本变更补充回归覆盖而非修复：`MockAdapter` 新增 `hang-before-start` 条目（在任何 chunk 之前挂起、由 cancel 终止），`cancel.spec.ts` 固定"该窗口内的 disposed-cause cancel 仍以 aborted 结束 turn 且没有流式输出"，TypeScript 快照 close 套件新增 `close-pending` 探测——在真实 runtime 上于 replay 流产出首块之前挂起时关闭，断言 wire 事件与持久日志都以 `turn/end { kind: 'aborted' }` 结尾。Python 的 `sdk-close` smoke 镜像了两个后续：对已关闭命名 id 的再次 prompt 必须持久地完成，以及响应被完全扣留的 pending close 被中止进同一 `turn/end` 词汇。`close-pending` 的 replay sidecar 需要一个"输出前挂起"条目，因此 `llm-replay` 的 `hang` override 条目新增了经过校验的 `beforeStart: true` 变体，跳过它的两块前缀。

## Alternatives considered

**在持久化协调器中为已释放 id 开启一份干净的新日志。** 否决：没有新的破坏性接口，协调器与后端都做不到。已构造的 live Session 无法事后补种，`createCore` 拒绝任何对已持久化身份的 create（"load/resume it instead"），JSONL 后端按设计拒绝在既有日志上物化。为了满足一次 re-prompt 而抹掉已关闭 turn 的持久日志，等于用一个 wire 契约缺陷换静默的持久化丢失。

**把冲突守卫限定在并发生命周期，并在重建时删除已退役的 artifact。** 否决，同样的破坏性重置代价，外加墓碑的生命周期问题：协调器必须永久保留每个已释放 id（无界表）或猜测墓碑何时过期，且删除仍需要每个后端实现的新 seam 成员。

**在 server 侧对 re-prompt 报错，让调用者换用新 id。** 否决：这会把文档化契约（"对该 id 的后续 prompt 会创建全新 session"）变成错误，并改变所有既有调用者的 SDK wire 表面。

## Consequences

close 后的 re-prompt 流程在两个 SDK 上都能完成并持久化：TypeScript 快照套件用 keyless 的 `close-reprompt` 探测固定它，server 套件固定分发契约（id 有日志时 resume 胜出，仅在无日志回退时 create）以及真实组合的重新挂接（第二次模型请求携带第一个 turn 的历史），Python smoke 在 mock 模型上镜像该流程。pending-close 窗口在三层被固定——agent-loop 单测、llm-replay 条目语义、真实 runtime 探测——两个取消窗口不会再无声漂移。代价：对已关闭 id 的 re-prompt 会延续该 id 的既有对话而非从空白开始；想要熟悉 id 下空白历史的调用者必须铸造新 id，server/client 的 close 文档现在写明新 session 会恢复该 id 的持久日志。
