# Agent Note: Durable issue automation

Status: implemented

[English](2026-08-23-durable-issue-automation.md) | 中文

## Problem

Relay Harness 已能运行持久 Session、Subagent、Job、Schedule 和可恢复 Workflow Script，但没有组件负责持续读取 Tracker、claim 可执行工作、准备隔离的 Issue 目录、对账 Tracker 变化，或向 Operator 暴露 retry 与 blocked 状态。把该策略放进 `agent-loop`、Schedule、Workflow 或现有 Workspace Registry，会让模型运行时组件拥有外部业务队列，并重复已有状态 Owner。

## Decision

Issue Automation 是由独立 capability seam 组成的 opt-in layer。`@relay-harness/rlh-tracker` 注册 effect-scoped Provider，并为每次运行捕获一个 Provider／配置／工具／凭据环境变量别名 binding。`@relay-harness/rlh-issue-workflow-file` 读取仓库 Markdown／YAML 策略，拒绝无效启动文档，并在 reload 失败后保留最后有效版本。`@relay-harness/rlh-issue-workspace-local` 拥有确定性路径、canonical containment、设置回滚、有界 hook 和终态删除，不改变 `WorkspaceRegistry` 现有 Session 分组契约。

`@relay-harness/rlh-issue-runner-agent` 在准备好的目录创建一个原生 Agent Session，在发布前安装捕获的 Tracker 工具；只要按精确 ID refresh 后 Issue 仍可执行，就在有界 continuation 轮次中复用同一 Session。`@relay-harness/rlh-issue-orchestrator` 是唯一调度写者。Storage-domain row 会在 Workspace 或 Agent 副作用前提交 `claimed`，并物化 `running`、`retrying` 或 `blocked`；启动时把中断的 claimed／running row 转成即时持久重试。每次 poll 都先对账 running 与 blocked Issue，再 dispatch 候选项；按精确 ID 重验每个候选项；执行全局与 per-state capacity；检测事件静默；并应用有界指数退避。完成后仍可执行的再派发会递增 attempt 并使用指数 continuation 退避，在配置上限处停在 blocked 状态；启动 Workspace 清理只触碰有持久 claim 记录的 Issue。Live handle 与 timer 是持久 row 的投影，而不是恢复事实。

首个完整 vertical slice 是 Linear。Provider 分页读取项目范围候选项、批量读取对账项、规范化路由事实，并暴露 session-bound、Host 执行的 `linear_graphql` 工具，而不把 token 交给 Agent。生成的 Typert contract 暴露 snapshot、refresh、retry 和 release。浏览器插件通过原生 titlebar／overlay contribution 呈现 running、retrying、blocked 条目。只有部署在 Web bundle 后加入 `@relay-harness/rlh-issue-automation` 时，才会组合完整 layer。

## Durable and security rules

Issue 身份由 Provider 拥有并带 brand。记录保留接纳该 attempt 的 Provider 与 Workflow revision。Tracker tool binding 保证广告与执行使用同一个捕获 Provider。本地 Workspace 创建和删除都会重新验证 canonical root containment；复用目录在设置失败后不会被破坏性重置。Tracker 凭据保留在 Host 闭包中；Provider 声明的环境变量别名是声明性元数据，managed child 清理由 subprocess seam 的通用凭据特征父环境擦除完成，该声明并不驱动它。Operator 只能 retry 或 release 非运行记录；Tracker reconciliation 仍是停止 live work 的常规 Authority。

## Alternatives considered

**用 Tracker polling 扩展 WorkflowEngine。** 不予采用，因为 Workflow 在一个 Parent Agent 下执行一次 holder-owned Script，而 Issue Orchestration 跨无关 Session 拥有外部队列、持久 claim 和 Operator 状态。

**把 Schedule reminder 当作 Issue Job。** 不予采用，因为 Schedule 是 Agent-scoped，并在一个 Session 内 event-source。Tracker claim 必须先于任何 Agent Session 存在，并在该进程消失后仍有意义。

**把 WorkspaceRegistry 复用为目录 Provisioner。** 不予采用，因为该服务持久分组既有 canonical 目录与 Session，并有意不创建、填充、重置或删除仓库内容。

**移植 Symphony 的 Elixir 服务或 App Server Client。** 不予采用，因为 Cordis effect、RLH Agent／Session、Tool Runtime、Subprocess Tree、Storage Domain、生成 Remote 和原生 Client Slot 已拥有这些机制。只改造行为与 invariant；Runtime 不引入 Elixir 源码或独立传输。

**把 claimed、retry、blocked 状态留在内存。** 不予采用，因为 Host 重启会静默释放工作并丢失 Operator intervention。持久 row 可显式恢复，而不会假装进程或模型 stream 幸存。

**一次交付所有 Tracker Adapter。** 不予采用，因为完整 Linear slice 已证明 Provider seam、Host tool snapshot、凭据处理、reconciliation 和分页。新增 Provider 应保留原生语义，而不是符合浅层 CRUD 抽象。

## Verification

Tracker 测试固定 effect dispose、捕获 binding 在移除后仍有效、未知工具失败、schema 校验、Linear 分页、路由规范化、Host auth、瞬时 Viewer 查询失败后的恢复和有界失败。Workspace 测试执行真实 managed hook，并固定一次性设置、复用、回滚、抗碰撞 key 和符号链接逃逸拒绝。Workflow 测试固定 typed parsing、严格失败、revision 变化和 last-known-good reload。原生 Runner 测试通过真实 Agent Loop 执行捕获的 Tracker 工具和两个 continuation 轮次。Orchestrator 测试固定持久 claim 到 run 发布、终态清理、blocked 持久化、Operator retry 和 refresh 合并；bundle 的 REAL-composition 测试通过 Loader 在内存 Tracker stub 上启动已交付 patch。生成 Typert 输出、Host／Client type face、bundle 配置校验、包 invariant companion、原生 Client slot／组件测试和双语文档 gate 覆盖其余集成面。

## Consequences

Harness 可以运行仓库拥有的 Issue 队列，而不削弱 Agent Loop 或重复 Session 状态。Crash 会丢失 live process state，但保留为何 claim、在哪里运行、下一 attempt 是什么，以及是否需要 Operator 介入。运行内 continuation 保持一个模型前缀；Host recovery 则在保留的 Workspace 上创建新 Session，而不是呈现虚假 continuation。

该 layer 增加多个包，因为 Tracker、策略、Workspace、执行、调度、传输和呈现会独立演进。已交付 Scheduler 是单 Host；active/active 需要后续带 compare-and-set lease 的 Storage Provider。Linear 原始工具有意保留配置 token 的原生可达范围，因此部署策略仍负责允许的变更和 Provider 侧幂等性。
