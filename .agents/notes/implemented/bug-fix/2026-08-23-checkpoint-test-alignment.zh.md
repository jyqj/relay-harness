# Agent Note: checkpoint 测试对齐与 desktop checkpoint 回归修复

Status: implemented

[English](2026-08-23-checkpoint-test-alignment.md) | 中文

## Problem

integrated-desktop checkpoint 留下了十七条失败测试和失同步的质量门。`parseDshArgs` 新增了 `skipUserPlugins` 但测试期望未跟进。dsh release family 的 glob 覆盖 `apps/*/package.json`，把私有的、独立版本线的 desktop 安装包拉进 npm 发布族并触发 `@deepseek-ai` 命名断言失败。新增的 issue-orchestration 面板 CSS 在抬升表面上滚动却没有 scrollbar rebind。四个客户端行为回归或漂移：feedback 弹层的 fixed 层缺 no-drag 孔；测试与 locale 文案承诺的路由级 `defaultInput` 编辑器在 `ProviderEditor` 中缺失；`WorkflowRunPanel` 不再结算延迟的 phase 关闭（disclosure 退出过渡让焦点留在折叠树内）；connection/subagent 测试仍在断言 checkpoint 之前的生命周期（unary handshake、root-tree admission 以调用方 abort reason 抛出、防抖的 theme 写入）。

## Decision

测试期望对齐 checkpoint 的既定契约：launcher 解析暴露 `skipUserPlugins`（含一个 true 用例）；dsh family 排除 `apps/desktop`——它保持自己的安装包版本线；connection、wire-event、subagent、theme、settings-desktop、disclosure 过渡套件断言新的时序与 admission 语义。产品修复恢复预期行为：`.notePanel` 补 `-webkit-app-region: no-drag`；`ProviderEditor` 渲染路由级 `defaultInput` 模态编辑器（含继承 hint、空值拒绝、禁用 Apply）；`WorkflowRunPanel.toggleRun` 在 run 折叠时结算各 phase 的 pending clean collapse。`IssueOrchestrationPanel.module.css` 在滚动 body 上 rebind l2 scrollbar thumb token。

## Alternatives considered

**把 desktop 包重命名进 `@deepseek-ai` scope。** 拒绝：workspace 约束工具已把 `apps/desktop` 划为带独立版本线的私有应用；从共享 family 排除与该既有决定一致。

**去掉 `usePresence` 退出过渡以保留同步折叠断言。** 拒绝：该过渡是已发布的 2026-08-14 web-motion 行为；延迟关闭的结算应落在 `WorkflowRunPanel`。

## Verification

原先失败的十四个测试文件定向运行通过（376 条）；批次后重跑了全仓 typecheck、lint 与 vitest 均干净；release-family spec 断言 desktop 排除。

## Consequences

该二开的自有门禁重新全绿。subagent 发布前取消现在通过 admission seam 的 abort-reason 契约断言，而不是 root-tree admission 使之不可达的 provider 前置 guard。
