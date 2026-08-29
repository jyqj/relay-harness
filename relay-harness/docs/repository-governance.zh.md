# 仓库治理

[English](repository-governance.md) | 中文

## 正典布局

Git checkout 是外层容器：`relay-harness/` 是唯一 tracked 产品/runtime monorepo；本地 `auggie-packages/` 与 `codecortex-rust_副本/` 参考项目保持 untracked 和 ignored。产品文档、包源码、应用、脚本与构建配置全部位于 `relay-harness/` 下。

`docs/feature-status.json` 以 `runtimeRoot: "relay-harness"` 和 `sourceLayout: "nested-monorepo"` 记录该事实。在远端 ruleset 被实际观测前，`branchProtection` 继续为 `unconfigured`。

GitHub 只从根 `.github/` 发现自动化，因此 workflow、Issue policy 与 Dependabot 保留在 Git 根。普通 workflow shell step 使用 `working-directory: relay-harness`；Landlock shell step 使用 `relay-harness/native/landlock-run`。Dependabot 的 npm 目录为 `/relay-harness`，Python SDK 目录为 `/relay-harness/python/sdk`。

## 远端审计快照

2026-08-30 通过 GitHub API 观测到：

- 仓库为公开的 `jyqj/relay-harness`，默认分支是 `master`；
- 远端 `master` 仍为 `b65b3feeb2`，本地分支包含已经审计的实现 commit；
- GitHub 列出 8 条历史 workflow 记录，本地根目录则包含 15 个 workflow 定义；
- `master` 没有 classic branch protection，也没有 ruleset；
- 仓库没有 Actions variable、secret、environment 或 self-hosted runner，因此 CI 使用标准 hosted runner，真实 API e2e 保持 manual-only，Issue Project 自动化与 enterprise runner benchmark 显式禁用，release publication 保持人工执行。

Tracked 根 workflow 目录恢复 GitHub 发现能力，同时不把 runtime 源码散放在外层。只有推送 commit 后才能确认远端发现状态；配置 required-check ruleset 前，必须先验证 workflow 注册和一次 keyless CI。

## 必须完成的远端后续

1. 推送根治理与 `relay-harness/` runtime commit。
2. 确认 GitHub 列出 `.github/workflows/` 下全部 workflow，且 `repository governance` 通过。
3. 为 `master` 配置 ruleset：必须经过 PR，并要求稳定的 `all checks passed` check；携带 secret 的 e2e 是否设为 required 需单独裁决。
4. 再次通过 API 读取 ruleset 与 check run；只有远端状态真实存在后，才可把 `docs/feature-status.json` 的 `branchProtection: unconfigured` 更新为已配置。

## 容器布局不变量

Tracked 产品/runtime 路径位于 `relay-harness/` 下；根 `.github/` 是唯一自动化权威。仓库检查会拒绝外层出现第二套 runtime tree，也会拒绝 workflow 路径逃离已声明的 runtime root。本地参考项目从 Git、Relay 文档门禁与索引门禁中排除。
