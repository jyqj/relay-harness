# Agent Note: knip 门禁范围修复

Status: implemented

[English](2026-08-26-knip-gate-scope-repair.md) | 中文

## 问题

`pnpm knip` 是一个信号被淹没的常红门禁：410 项发现中，114 条 "unlisted dependencies" 是仍导入 `@deepseek-ai/*` 的 rebrand 前陈旧 `lib/` 产物（knip 在分析工件面），184 个 "unused files" 是没有任何 knip workspace 建模的 `apps/desktop` Electron 入口面。本仓库从未有一次 CI 运行跑完，所以这个红从未被观察到。噪音之下有真实发现：六个 client 包与 issue orchestrator 共十个未使用 devDependencies、`rlh-settings` 在 `ui-git`/`ui-titlebar` 被生产代码使用却只声明为 dev、`zod` 藏在四个 per-workspace `ignoreDependencies` 条目里、desktop 的 `@types/ws` 已死。

## 决策

门禁现在只分析源码面：根级 `ignore: ["**/lib/**"]` 把构建工件从所有 workspace 移除，与 source-plane/artifact-plane 布局规则一致。`apps/desktop` 获得带已验证入口面（Electron preload、HTML 加载的 renderer 脚本、插件安装钩子、builder/QA/CDP 脚本）的 workspace，`apps/desktop/mobile` 为 Expo 壳与零依赖 mobile web SPA 单独设入口。已完成的 rebrand codemod 保留在树内（该决策由重命名 Agent Note 持有）并声明为根 workspace 的 entry。真实发现被修复而非压制：删除十个死 devDependencies、`rlh-settings` 在两个违规包中提升为 peer+dev（所有兄弟包的既有约定）、删除 `@types/ws`、解除 `zod` 的忽略。保留一处诚实的压制：`issue-automation` 的 `ui-issue-orchestration` 经 `cordis.patch.yml` 裸插件字符串组合（knip 看不见）。修复期间为 `ui-git`/`ui-titlebar` 加的 per-workspace 忽略后来被证明是在掩盖其真实缺陷——`rlh-settings` 在 `dependencies` 中与 peer+dev 三方并存，`verify-client-packages` 将其判定为三方违规；删除 `dependencies` 副本后 knip 直接满足，忽略条目随之删除。

desktop 的 71 个未使用导出经根级 `rules.exports` 以 `warn` 级报告——每次运行可见、不阻断——因为无类型 JS 世界需要先做自己的死导出清理，而不是静默放行。

## 已否决的替代方案

**把 exports 设为 error 并立即删除 71 个 desktop 导出。** Electron 主进程经动态路径加载模块（打包资源查找、插件运行时），静态分析无法完全看清；在没有这些知识的情况下批量删除，是为门禁胜利冒运行时破坏之险。推迟到 desktop TS 迁移。

**等 desktop 完美建模后再让门禁变绿。** 常红门禁等于没有门禁；本变更把它从坏掉修到"绿色带警告"。

## 后果

`pnpm knip` 以 exit 0 退出，附 71 个 warn 级发现，全部位于 `apps/desktop` 与 `mobile/web`——这是无类型世界的量化死导出存量，每次 hygiene 运行可见。exports 规则是棘轮：desktop 清理落地后扳回 error。根级 `ignore: ["**/lib/**"]` 也保证新构建的产物永远不会再污染发现。仅剩的一处 per-workspace 依赖压制是 knip 盲区的常设清单（cordis.yml 字符串组合）——knip 升级时重新审视。

## 测试

清空 `node_modules/.cache/knip` 后 `npx knip` exit 0；被编辑包的测试通过（`ui-git`、`issue-orchestrator`：13 个文件、156 个用例）；依赖删除后 `pnpm install` 重新同步了 lockfile。
