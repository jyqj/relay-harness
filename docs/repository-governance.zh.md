# 仓库治理

[English](repository-governance.md) | 中文

## 正典布局

Git 根目录是唯一仓库权威。TypeScript monorepo、产品文档、包源码、应用、脚本与 GitHub 元数据都直接位于该根目录；tracked tree 中不再保留嵌套源码 monorepo。

`docs/feature-status.json` 以 `runtimeRoot: "."` 和 `sourceLayout: "root-monorepo"` 记录该事实。在远端 ruleset 被实际观测前，`branchProtection` 继续为 `unconfigured`。

GitHub 只从根 `.github/` 发现自动化，因此 Issue 模板、policy、Dependabot、全部 15 个 workflow、CI、e2e、文档、sandbox 和 release workflow 只有一个正典位置。普通 workflow shell step 与 action-owned path 从仓库根解析；Landlock shell step 使用 `native/landlock-run`。Dependabot 的 npm 目录为 `/`，Python SDK 目录为 `/python/sdk`。

## 远端审计快照

2026-08-29 通过 GitHub API 观测到：

- 仓库为公开的 `jyqj/relay-harness`，默认分支是 `master`；
- 审计开始时远端 `master` 为 `b65b3feeb2`；
- 远端根只含 `README.md`、`docs/` 和 `relay-harness/`，没有根 `.github/`；
- GitHub 仍列出 6 条历史 workflow 记录，但最后一次分支运行停在 2026-08-23 的 `a72dc590f6`，之后的 `master` commit 没有 check run；
- `master` 没有 classic branch protection，也没有 ruleset；
- 仓库没有 Actions variable、secret、environment 或 self-hosted runner，因此 CI 使用标准 hosted runner，真实 API e2e 保持 manual-only，Issue Project 自动化与 enterprise runner benchmark 显式禁用，release publication 保持人工执行。

Tracked tree 已恢复根 workflow 发现。只有推送该 commit 后才能确认远端发现状态；配置 required-check ruleset 前，必须先验证 workflow 注册和一次 keyless CI。

## 必须完成的远端后续

1. 推送根 workflow 与扁平布局迁移。
2. 确认 GitHub 列出 `.github/workflows/` 下全部 workflow，且 `repository governance` 通过。
3. 为 `master` 配置 ruleset：必须经过 PR，并要求稳定的 `all checks passed` check；携带 secret 的 e2e 是否设为 required 需单独裁决。
4. 再次通过 API 读取 ruleset 与 check run；只有远端状态真实存在后，才可把 `docs/feature-status.json` 的 `branchProtection: unconfigured` 更新为已配置。

## 扁平布局不变量

Tracked source tree 与物理 checkout 都不含 `relay-harness/` 路径。仓库检查会拒绝嵌套 workflow 权威、嵌套 operational prefix 与重新创建的物理源码根。历史嵌套路径只保留在 Git 历史中。
