# Agent Note: memory、issue automation 与 desktop 的审计修复

Status: implemented

[English](2026-08-23-audit-remediation-memory-automation-desktop.md) | 中文

## Problem

对该二开仓库的四路审计发现：`tool-memory` 接受任意成功的工具结果作为 `action-verified` 证据，模型可以把 `memory_search` 输出洗白为 active 条目；memory 反馈闭环（`supersedes`/`supersededBy`、`usefulAccessCount`、`MemoryStatus 'superseded'）没有任何写入方；`enqueue` 的 dedupe check-then-insert 跨进程存在竞态；没有机制检测第二个进程打开同一个 `memory.db`；上下文预算截断混用 UTF-16 code unit 与 code point 长度。issue orchestrator 对"完成但仍 eligible"的 issue 重派发时把 `attempt` 重置为 1 且无上限；启动清理分页拉取全部终态 tracker issue 并删除从未 claim 过的 issue 目录；due-retry 与候选派发每个 id 一次 GraphQL 调用；tick 失败路径在 `catch` 内读配置可能静默停止轮询；`fetchIssuesByIds` 对 malformed 200 响应返回 `[]`。desktop 的 `node --test` 套件不在任何 CI lane；session-tree 画布打开时并发拉取 workspace 内全部会话的完整分页历史；约 1,460 行 QA walker 随安装包 asar 分发；primitives 的 `Tooltip` 没有 Escape 处理。文档缺口：`secretEnvironmentNames` 被描述为驱动 managed-child 擦除但无运行时消费者；根 `AGENTS.md` 与 `packages/README.md` 缺少 `tracker/` 与 `automation/` 分组。

## Decision

证据校验共享化：`rlh-memory` 导出 `memoryExcludesDerivedTool`（`memory_*`/`session_*`/`skill`），extractor 的本地副本删除，`tool-memory` 把每个 `tool/result` 解析回其 `tool/call` 名称，派生或无配对的结果不能激活 `action-verified`。通过 `remember` 复活已死 identity 时在同一事务内写 `supersedes`/`supersededBy` 对；`forget` 不留链。`usefulAccessCount` 在既有 `BEGIN IMMEDIATE` 读事务内递增，fail-open。`enqueue` 的 dedupe 读与插入移入同一个 `BEGIN IMMEDIATE` 事务，冲突时返回已存在的 job。schema version 3 新增单行 `memory_store_owner` 心跳（pid、boot id、时间戳）：新鲜的他进程心跳在启动期 fail-loud，每个写事务刷新并重新断言所有权，干净关闭即释放；`ownerStaleMs` 是经过校验的 Config 字段（默认 30 秒）。预算截断统一按 code point 计数。

orchestrator 的 continuation 路径递增 `attempt` 不重置，退避 `min(continuationRetryMs × 2^(attempt-1), maxRetryBackoffMs)`，在 `maxContinuationAttempts`（校验过的 policy 字段，默认 5，0 关闭）处停止并进入 `blocked`——现有操作员 retry 路径已经能呈现该状态。启动清理只遍历本地 durable claim 记录并按批拉取这些 id；provider 永远不会收到针对未 claim issue 的删除。due-retry 与候选派发在 capacity 复查前按 provider 批量做 exact-id 读。tick 在进入可能失败的代码前先读取不会抛出的回退间隔；配置连续失败后轮询继续。`fetchIssuesByIds` 校验 `data.issues.nodes` 链并对 malformed 响应抛错，与 `fetchIssuesByStates` 对齐。删除无抛出点的 `IssueOrchestrationError` 死代码；`tracker-linear` 的默认状态集合收敛为单一常量。issue-automation bundle 新增 REAL-composition 测试，用内存 tracker 通过 Loader 启动发布的 `cordis.patch.yml`。scrubbing 相关表述改为：别名字段是声明性元数据，实际擦除由 subprocess seam 的 credential-shaped `scrubbedParentEnv()` 完成。

`desktop-tests` 成为 `run-gates.ts` 的 gate，进入 `ci-primary`、`ci-static` 与 `check-all`。session-tree 画布打开时零历史请求：图结构纯靠列表元数据（`parentSessionId`/`seedLength`）渲染 stub 卡，完整历史在选中卡片时以并发上限 4 加载并支持 AbortController 取消，prune 保留未加载会话的布局状态。`build.files` 把 `release-ui-walk.js` 与 `composer-official-qa.js` 排除出 asar；打包 smoke helper 保留，因为 `run-packaged-smoke.mjs` 断言其命中数。`Tooltip` 支持 Escape 关闭且不移动焦点。布局树与分组表列入 `tracker/` 与 `automation/`。

## Alternatives considered

**把 `secretEnvironmentNames` 接入 subprocess 环境构造。** 本次拒绝：会侵入上游布局拥有的 `rlh-subprocess` seam；改为如实记录声明性语义。

**为耗尽的 continuation 新增 `paused` 终态。** 拒绝：新状态会波及 client UI 与 snapshot 面；`blocked` 已表达"需操作员介入"且可见。

**把内联的打包 smoke helper 排除出 asar。** 拒绝：`run-final-gates.mjs` 以打包 smoke 命中数作为发布阻断；移除会破坏发布 gate。改为排除约 1,460 行 QA walker。

**与 `usefulAccessCount` 一起追踪 `lastAccessedAt`。** 拒绝：没有消费者读取它；新增会再造死字段。

**发出 `user_confirmed`/`user_rejected` 信号。** 拒绝：没有面向用户的 review surface；伪造来源会错误陈述出处。API 保留，README 注明等待 review surface。

## Verification

`packages/memory` 46 条、`packages/automation` + `packages/tracker` + `packages/bundle/issue-automation` 104 条、`packages/client/ui-session-tree` + `ui-primitives` 555 条、`apps/desktop` 649 条 node 测试通过，新增用例覆盖派生证据拒绝、双连接并发 enqueue、新鲜/过期 owner 心跳、指数 continuation 退避与上限、批量 fetch 次数、配置连续失败后轮询存活、malformed `fetchIssuesByIds`、画布懒加载。`run-gates.spec.ts` 断言新 gate 的 lane 归属。四个 Service Definition 包新增 invariant 伴生测试。批次完成后重跑了全仓 typecheck 与 lint。

## Consequences

审计的高严重度发现已关闭或注明为有意设计：vendored `rlhmarket`/`rlhbot` 树保留其被追踪的 `node_modules/`（由 `rlhmarket-preset.test.js` 守护的离线安装包设计），现在 `apps/desktop/vendor/README.md` 有说明。session-tree 画布初始只渲染 stub 卡；turn 文本与历史内搜索在点开卡片后出现。被 continuation 上限停止的 issue 需要操作员 retry。memory store 保持单 owner；并发的 CLI/Web standard 会话在第二个打开者处 fail-loud，而不是静默共享数据库。
