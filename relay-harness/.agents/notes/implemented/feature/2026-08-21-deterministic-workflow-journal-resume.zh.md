# Agent Note: 确定性 workflow journal 恢复

Status: implemented

[English](2026-08-21-deterministic-workflow-journal-resume.md) | 中文

## Problem

worker-thread workflow 可以运行许多昂贵 child call，却只公开 live holder。取消、进程丢失或 worker failure 会丢弃所有已完成中间结果；重新运行脚本会重复全部提供方工作与 side effect。只保存最终值无法帮助被中断 run，而序列化任意 JavaScript heap 状态既不可移植，也不兼容既有模型编写脚本 runtime。

恢复也不能盲目信任调用位置。已编辑或非确定性脚本可能在同一序号发出不同请求，却收到无关旧结果。持久 journal 必须拒绝这种 divergence，也不得接受不安全、无界或部分写入的输入。

## Decision

`WorkerThreadWorkflowEngine.Config.journalRoot` 是可选绝对目录。省略时保留无状态引擎。配置后，fresh run 会在 worker 发布前以 owner-only 文件 mode exclusive create `<journalRoot>/<sha256(runId)>/journal.jsonl`。`WorkflowStartRequest.resumeRunId` 选择既有 run id；未配置 root 时引擎会拒绝恢复。

带版本 header 携带 run id，以及对 script、已验证 meta、args、解析后的 subagent provider 和解析后的 total-agent cap 做规范 SHA-256 fingerprint。以任何已变化字段加载同一 run，都会在 worker 启动前同步以 `JOURNAL_DIVERGENCE` 失败。

每个 worker `agent()` 调用拥有确定性、从一开始的 `callId`。版本 2 的 journal 在提供方启动前 fsync intent，在向 worker 发布结果前 fsync terminal outcome。intent 包含序号与 request hash；outcome 增加已发布 child id 与 detached result 或稳定 failure。终态记录必须有匹配的 intent。旧 journal 格式会被拒绝。

恢复时脚本从第一条语句开始。匹配的 terminal outcome 在不执行提供方工作的情况下 replay。缺失序号只有在 intent 完成 fsync 后才开始 live suffix。匹配但未决的 intent 会以 `JOURNAL_OUTCOME_UNKNOWN` 失败，包括取消或终态追加撕裂的情况；不同请求以 replay divergence 失败。恢复要求先核对可能的副作用，再显式启动新 run。

Journal 上限为 64 MiB。Restore 只接受低于上限的非 symlink 普通文件，验证每个完整 row 与 intent 到 outcome 的迁移，并且只截断撕裂的最终 JSON line。调用可以乱序完成；每个序号至多有一个 intent 与一个匹配的 terminal outcome。

面向模型的 `workflow` 工具公开可选 `resumeRunId`，为其加 brand 并转发，绝不检查 storage 或回退到 fresh run。每个成功工具结果原本就返回 `runId`，它就是恢复 handle。

恢复先验证请求归属、全部完整记录、有限 JSON 结果及连续调用编号，再 fsync 修复最后一行；错误请求不会修改文件，缺失的较早调用不会被当成实时后缀执行。Writer claim 拒绝普通与悬空符号链接。任何 child 取消，包括 worker 死亡引发的取消，均保留未知结果 intent。

## Alternatives considered

**序列化 worker heap。** 不予采用，因为 Node vm promise、closure、realm object、pending port 与 native handle 不存在无损可移植 snapshot。Replay 让脚本继续充当 state machine，只存储 host-call fact。

**只 journal child id。** 不予采用，因为脚本消费 text 或 structured result；无法保证从已 dispose 或 remote child 重建它们。

**只按序号 replay，不使用 request hash。** 不予采用，因为已编辑或非确定性脚本会静默把旧结果绑定到新请求。header 捕获静态 input 变化，每个调用 hash 捕获动态 divergence。

**只记录 terminal outcome。** 不予采用，因为缺失终态记录无法区分尚未启动的调用与已经产生外部副作用的调用。持久 intent 无法重建结果，却可以阻止自动重复结果未知的调用。恰好一次的外部副作用仍需要提供方幂等或人工核对。

**把取消记录为 terminal call result。** 不予采用，因为取消是中断，而不是确定性业务 outcome。未决 intent 保持持久化，防止自动重试重复未知副作用。

**使用一个可变 JSON 文档。** 不予采用，因为重写会让 crash window 与内存随 run 增长。有界 append-only JSONL 支持逐调用 fsync 与最终 tail 修复。

**允许相对 journal path 或把原始 run id 用作目录。** 不予采用，因为依赖 cwd 的 storage 不稳定，调用方控制 id 也可路径穿越。配置 root 是绝对路径，目录 component 是固定 hex hash。

## Consequences

已完成 child call 可以在取消或进程重启后复用，无需再次联系提供方。Failure outcome 同样确定；已编辑脚本会 fail loud，而不是消费陈旧值。默认基础引擎保持无状态，因为不会凭空设定部署 storage path。

Journal 阻止自动重复结果未知的调用，不回滚外部副作用，也不重建任意 worker heap 状态。Run 在加载或修复 journal 前，在其旁持有 SQLite 独占 writer 事务。竞争 host 以 `JOURNAL_BUSY` 失败。该 OS claim 在 worker 退出且 child 完全停止后释放；有界 dispose 不能在放弃等待的 child 仍活动时释放它。进程死亡会释放锁，无需删除残留 PID 文件。Journal 要求可靠支持 SQLite 锁的本地文件系统。Phase/log narration 与局部变量在 replay 时重新计算。

worker-engine 测试覆盖终态 replay、保留未决 intent 的取消、divergence、append failure、不安全文件、撕裂尾部恢复、大小上限与规范 hash。Journal 测试验证撕裂的终态追加仍保留 intent，且未决调用绝不会作为尚未启动的 suffix 重试。

[真实 Loader 恢复快照](../../../../examples/acp-agent/tests/workflow-recovery.snapshot.ts) 启动签入的 workflow fixture，通过脚本化模型执行一个真实 spawn child，然后经第二个 host 恢复而不再次请求模型，并在模拟终态追加撕裂后拒绝 replay。预期输出保留稳定错误消息，不包含与机器相关的堆栈路径。

请求对象的键采用与区域设置无关的 UTF-16 码元顺序；数组顺序仍有意义。英语与土耳其语区域设置的子进程回归防止宿主排序规则改变同一请求的指纹。
