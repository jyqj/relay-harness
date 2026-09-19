# Agent Note：有界任务停止与 control-lost-unknown 记录

Status: implemented

[English](2026-09-20-bounded-job-stop-and-control-lost-unknown.md) | 中文

## 问题

`LocalJobRegistry` 在每次销毁取消后无界地等待 `job.settled`，而 `kill()` 发出的停止请求会永远悬置。一个 `cancel` 返回但从不结算 `JobHooks.done` 的生产方与缓慢停止无法区分：其记录停留在 `stopping`，在服务剩余生命周期内持续占用一个准入名额，并让 owner 释放与服务释放无限期停滞。唯一可检测的失败是取消抛出异常。读取方也没有诚实的途径看到"停止已请求、结果未知"——每一个已关闭状态都声称是生产方确认过的终止。

## 决策

停止路径是有界的，并且只声明注册表真正知道的事实。

- **有界停止协议。** 每次停止请求——`kill()` 或销毁取消——都会挂载按任务的监视器。经过停止宽限期（`Config.stopGraceMs`，默认 `5000`，或按任务的 `JobStart.stopGraceMs` 覆盖）仍无 `done` 结算时，注册表升级到生产方可选的 `JobHooks.terminate` 钩子再等一个宽限期，然后把记录关闭为 `control-lost-unknown`。任何时点的结算都会清除监视器，守约的生产方永远支付不到这个界限。
- **`control-lost-unknown` 是已关闭但未确认的状态。** 它加入 `JobStatus`，与终止状态一样携带 `finishedAt`（有界停止放弃的时刻），并在与结算相同的首次优先提交下释放等待方、恰好通知一次监听器——但它绝不声称工作已停止。生产方迟到结算只写日志；记录保持不可变。`JobRegistry` 的结算词汇不新增生产方侧结果：`JobOutcome` 仍只枚举生产方能确认的结果。
- **销毁不再挂起。** `disposeOwned` 与 `disposeAll` 仍等待 `settled`，但监视器会在两个窗口内关闭所有未确认记录，因此销毁无需生产方配合即可完成。取消抛出时的强制失败保持不变。
- **容量受约束，而非被静默释放。** `control-lost-unknown` 记录继续计入 `maxConcurrentJobsPerOwner`——其工作可能仍在运行——且保留期回收永不丢弃它。每个桶最多累积 `Config.maxUnconfirmedJobsPerOwner`（默认 `5`）条；超过上限时 reconciliation 丢弃最早结算的未知记录、发出警告并发布移除，使容量释放是显式的，被丢弃的 id 读作 `unknown job <id>`。
- **状态端到端可见。** apiproxy 的线上视图（`JobView`）及其 zod schema 携带 `control-lost-unknown`，jobs 面板以专属标签（"停止未确认，结果未知"）和注意色圆点渲染，与 `killed` 可区分。`rlh-tool-jobs` 原样呈现状态，模型侧通知无需改动即可显示未知状态。

## 已考虑的替代方案

- **无界等待结算并依赖生产方正确（现状）。** 落选：一个行为不当的生产方会冻结其 owner 的释放并永久泄漏一个准入名额；缺陷注释本身就承认了这一停滞。
- **宽限期一过就伪造终止 `killed`。** 否决：它谎报了这条记录存在的唯一理由——生产方从未确认任何事，而下游通知/报告路径会把结果未知的工作当作已干净停止。
- **未知记录达到上限后拒绝新任务。** 在本 provider 中否决：触顶的 owner 在重启前将永远无法再启动工作。丢弃最早的未知记录保持桶可用，同时让释放变得响亮且显式。
- **让停止界限派生自 `wait()` 超时或每次调用的参数。** 否决：停止是注册表与 owner 的生命周期策略，不属于单个调用方；配置默认值加上按任务的 `JobStart.stopGraceMs` 覆盖，把决策留给拥有该生产方的组合。

## 后果

买到：owner 与服务释放无需生产方配合即可完成；结果未知的工作以独立状态出现在注册表快照、线上视图与 UI 中；未知记录占用的容量有界，且只通过显式且带警告的 reconciliation 释放；`rlh-jobs` 的快照不变量现在把 `finishedAt` 绑定到已关闭状态集合（三个终止状态加 `control-lost-unknown`）。

成本：provider 新增两个配置字段（`stopGraceMs`、`maxUnconfirmedJobsPerOwner`）和一个既有生产方尚未实现的可选钩子（`JobHooks.terminate`）——没有它界限是一个窗口而非两个；被 reconciliation 丢弃的记录的工作按设计不再被跟踪，警告是唯一痕迹；`control-lost-unknown` 之后生产方迟到结算只记日志，不入记录。

`rlh-jobs-local` 注册表套件覆盖正常 kill、无 terminate、terminate 后结算、terminate 被忽略三条升级路径、迟到结算、owner 与服务在无结算下的销毁、容量保留与上限 reconciliation；apiproxy 套件钉住线上帧序列 `running → stopping → control-lost-unknown` 及其与 `killed` 的可区分性。
