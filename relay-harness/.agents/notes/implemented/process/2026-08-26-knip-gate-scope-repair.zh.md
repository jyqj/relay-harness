# Agent Note: knip 门禁范围修复

Status: implemented

[English](2026-08-26-knip-gate-scope-repair.md) | 中文

## 问题

`pnpm knip` 是一个信号被淹没的常红门禁：410 项发现中，114 条 "unlisted dependencies" 是仍导入 `@deepseek-ai/*` 的 rebrand 前陈旧 `lib/` 产物（knip 在分析工件面），184 个 "unused files" 是没有任何 knip workspace 建模的 `apps/desktop` Electron 入口面。本仓库从未有一次 CI 运行跑完，所以这个红从未被观察到。噪音之下有真实发现：六个 client 包与 issue orchestrator 共十个未使用 devDependencies、`rlh-settings` 在 `ui-git`/`ui-titlebar` 被生产代码使用却只声明为 dev、`zod` 藏在四个 per-workspace `ignoreDependencies` 条目里、desktop 的 `@types/ws` 已死。

## 决策

门禁通过显式 workspace `entry` 与 `project` pattern 只分析源码面，在不使用冗余全局 `lib` ignore 的情况下符合 source-plane/artifact-plane 布局规则。`apps/desktop` 获得带已验证入口面（Electron preload、HTML 加载的 renderer 脚本、插件安装钩子、builder/QA/CDP 脚本）的 workspace，`apps/desktop/mobile` 为 Expo 壳与零依赖 mobile web SPA 单独设入口。已完成的 rebrand codemod 保留在树内（该决策由重命名 Agent Note 持有）并声明为根 workspace 的 entry。真实发现被修复而非压制：删除死依赖，包括 Context／Remote 增量后遗留的 7 个 `zod` 声明；`rlh-settings` 在两个违规包中提升为 peer+dev（所有兄弟包的既有约定），并删除 `@types/ws`。保留一处诚实的压制：`issue-automation` 的 `ui-issue-orchestration` 经 `cordis.patch.yml` 裸插件字符串组合（knip 看不见）。修复期间为 `ui-git`/`ui-titlebar` 加的 per-workspace 忽略后来被证明是在掩盖其真实缺陷——`rlh-settings` 在 `dependencies` 中与 peer+dev 三方并存，`verify-client-packages` 将其判定为三方违规；删除 `dependencies` 副本后 knip 直接满足，忽略条目随之删除。

后续外层容器迁移又暴露出 package scripts 无法让 knip 识别的两类入口：仅由 workflow 调用的 `scripts/build-exe-for-python-sdk.ts`，以及只在源码 checkout 中按名称加载的两个 QA 模块。它们现在都是显式 entry。报告的 71 个 Desktop 导出没有被压制，而是逐一审计：`runReleaseUiWalk` 与 `runComposerOfficialQa` 作为两个动态选择的 QA 入口函数保留，其余 69 个未使用常量、helper 与重复 re-export 不再扩大 CommonJS 或浏览器模块 Interface。

## 已否决的替代方案

**把 71 个 Desktop 导出全部压制到 TypeScript 迁移之后。** 逐一审计后否决：只有两个名称通过动态选择到达；把其所在文件声明为本来就是的 entry，即可保留这些 Interface，而不隐藏无关死导出。

**等 desktop 完美建模后再让门禁变绿。** 常红门禁等于没有门禁；本变更把它从坏掉修到"绿色带警告"。

## 后果

`pnpm knip --treat-config-hints-as-errors` 以 exit 0 且无发现或配置提示退出。显式源码 `project` pattern 避免分析构建 bundle；显式 workflow/QA entry 则保留动态到达代码，又不压制其同文件的其他导出。仅剩的一处 per-workspace 依赖压制是 knip 盲区的常设清单（cordis.yml 字符串组合）——knip 升级时重新审视。

## 测试

完成入口和导出审计后，`pnpm knip --treat-config-hints-as-errors` exit 0；Desktop tests、lint 与 typecheck 覆盖收窄后的私有 Interface。
