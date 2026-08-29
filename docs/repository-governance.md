# 仓库治理

## 正典布局

本次审计 checkout 的 Git 根目录是 `/Users/jin/Desktop/Relay`。产品文档与 GitHub 元数据位于根目录；已实现的 TypeScript workspace 暂时保留在 `relay-harness/`，等待独立、干净的 flatten 迁移窗口。

GitHub 只从根 `.github/` 发现自动化，因此 Issue 模板、policy、Dependabot、可复用 workflow、CI、E2E、文档、sandbox 和 release workflow 全部以根目录为唯一正典。Shell step 显式在 `relay-harness/` 执行；由 Action 自己解析的 cache 和 artifact 路径则显式带 `relay-harness/` 前缀。

## 远端审计快照

2026-08-29 通过 GitHub API 观测到：

- 仓库为公开的 `jyqj/relay-harness`，默认分支是 `master`；
- 审计开始时远端 `master` 为 `b65b3feeb2`；
- 远端根只含 `README.md`、`docs/` 和 `relay-harness/`，没有根 `.github/`；
- GitHub 仍列出 6 条历史 workflow 记录，但最后一次分支运行停在 2026-08-23 的 `a72dc590f6`，之后的 `master` commit 没有 check run；
- `master` 没有 classic branch protection，仓库也没有 ruleset。
- 仓库没有 Actions variable、secret、environment 或 self-hosted runner；因此 CI 已改用标准 hosted runner，真实 API E2E 保持 manual-only，Issue Project 自动化与 enterprise runner benchmark 显式禁用，release publication 只保留人工入口。

本次变更在提交树中恢复根 workflow 发现。只有推送该 commit 后才能确认远端发现状态；推后必须先验证 workflow 注册和一次 keyless CI，再配置 required-check ruleset。

## 必须完成的远端后续

1. 推送根 workflow 迁移。
2. 确认 GitHub 列出 `.github/workflows/` 下全部 workflow，且 `repository governance` 通过。
3. 为 `master` 配置 ruleset：必须经过 PR，并要求稳定的 `all checks passed` check；携带 secret 的 E2E 是否设为 required 需单独裁决。
4. 再次通过 API 读取 ruleset 与 check run；只有远端状态真实存在后，才可把 `docs/feature-status.json` 的 `branchProtection: unconfigured` 更新为已配置。

## Flatten 边界

本次没有 flatten 源码 monorepo，因为 checkout 存在大量并行、未提交的功能改动。此时移动数千条路径会掩盖所有权并让冲突恢复失去可靠边界。未来 flatten 必须在干净专用 branch 执行，并在合并前证明 workflow、包路径、文档、release 与 Git 历史连续性。
