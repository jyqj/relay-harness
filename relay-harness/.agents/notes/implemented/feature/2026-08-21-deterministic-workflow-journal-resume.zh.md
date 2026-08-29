# Agent Note: 确定性 workflow journal 恢复

Status: implemented

[English](2026-08-21-deterministic-workflow-journal-resume.md) | 中文

## Problem

worker-thread workflow 可以运行许多昂贵 child call，却只公开 live holder。取消、进程丢失或 worker failure 会丢弃所有已完成中间结果；重新运行脚本会重复全部提供方工作与 side effect。只保存最终值无法帮助被中断 run，而序列化任意 JavaScript heap 状态既不可移植，也不兼容既有模型编写脚本 runtime。

恢复也不能盲目信任调用位置。已编辑或非确定性脚本可能在同一序号发出不同请求，却收到无关旧结果。持久 journal 必须拒绝这种 divergence，也不得接受不安全、无界或部分写入的输入。

## Decision

`WorkerThreadWorkflowEngine.Config.journalRoot` 是可选绝对目录。省略时保留无状态引擎。配置后，fresh run 会在 worker 发布前以 owner-only 文件 mode exclusive create `<journalRoot>/<sha256(runId)>/journal.jsonl`。`WorkflowStartRequest.resumeRunId` 选择既有 run id；未配置 root 时引擎会拒绝恢复。

带版本 header 携带 run id，以及对 script、已验证 meta、args、解析后的 subagent provider 和解析后的 total-agent cap 做规范 SHA-256 fingerprint。以任何已变化字段加载同一 run，都会在 worker 启动前同步以 `JOURNAL_DIVERGENCE` 失败。

每个 worker `agent()` 调用已经拥有确定性、从一开始的 `callId`。live child 达到一个 terminal host outcome 后，host 会 fsync 一条 JSON line，包含调用序号、规范 request hash、已发布时的 child id，以及 detached child result、start error 或 infrastructure failure。只有 append 成功后，host 才会向 worker 发布该 outcome。Append failure 会成为 fatal child infrastructure error；绝不会让脚本携带未记录结果继续。

恢复时，脚本从第一条语句开始。序号与 request hash 匹配的 journal entry 会通过既有 `child-started` 加 terminal 协议 replay，且不执行提供方工作；worker 因此发出相同的成对成员生命周期，并正常计算后续脚本值。已记录 start 或 result failure 会作为同一 failure replay。缺失 entry 标记 live suffix，并启动真实 child。hash 不匹配会让 run 以 replay divergence 失败。取消与其他 host teardown 不会记录未完成 suffix，因此后续恢复会重试它。

Journal 上限为 64 MiB。Restore 只接受低于该上限的非 symlink 普通文件，验证 header 与每个完整 row，拒绝重复序号与 malformed outcome，并且只截断撕裂的最终 JSON line。调用可以乱序完成，因此物理 JSONL 顺序不必等于调用顺序；sequence key 保持唯一，replay 按 call id 建索引。

面向模型的 `workflow` 工具公开可选 `resumeRunId`，为其加 brand 并转发，绝不检查 storage 或回退到 fresh run。每个成功工具结果原本就返回 `runId`，它就是恢复 handle。

## Alternatives considered

**序列化 worker heap。** 不予采用，因为 Node vm promise、closure、realm object、pending port 与 native handle 不存在无损可移植 snapshot。Replay 让脚本继续充当 state machine，只存储 host-call fact。

**只 journal child id。** 不予采用，因为脚本消费 text 或 structured result；无法保证从已 dispose 或 remote child 重建它们。

**只按序号 replay，不使用 request hash。** 不予采用，因为已编辑或非确定性脚本会静默把旧结果绑定到新请求。header 捕获静态 input 变化，每个调用 hash 捕获动态 divergence。

**在 child 执行前记录。** 不予采用，因为 intent record 无法在重启后提供 terminal value。恰好一次的外部 side effect 需要提供方幂等；本 journal 只保证 terminal outcome 到达 fsync 后可 replay。

**把取消记录为 terminal call result。** 不予采用，因为取消是 run 的中断，而不是 child 请求的确定性业务 outcome。让 suffix 缺失可使恢复重试有用工作。

**使用一个可变 JSON 文档。** 不予采用，因为重写会让 crash window 与内存随 run 增长。有界 append-only JSONL 支持逐调用 fsync 与最终 tail 修复。

**允许相对 journal path 或把原始 run id 用作目录。** 不予采用，因为依赖 cwd 的 storage 不稳定，调用方控制 id 也可路径穿越。配置 root 是绝对路径，目录 component 是固定 hex hash。

## Consequences

已完成 child call 可以在取消或进程重启后复用，无需再次联系提供方。Failure outcome 同样确定；已编辑脚本会 fail loud，而不是消费陈旧值。默认基础引擎保持无状态，因为不会凭空设定部署 storage path。

在外部 child effect 与 journal fsync 之间的狭窄 crash window 中，设计仍为 at-least-once。它是单进程／单 writer：在出现持久 lease 协议前，两个 host 不得并发恢复同一 run。Phase／log narration 与任意局部变量会在 replay 时重新计算；只有 host-call outcome 持久化。

worker-engine 测试覆盖 settled、start-error、result-error 与 unserializable-result replay；取消重试；script 与 call divergence；append failure；不安全文件；最终 tail 修复；边界；规范 hash；以及每个 journal 校验 branch。worker-thread 源码保持逐文件 100% statement、branch、function 与 line。
