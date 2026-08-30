# Agent Note：外层容器与 Runtime Root

Status: implemented

[English](2026-08-30-outer-container-runtime-root.md) | 中文

## 问题

本地 checkout 同时包含 Relay 和两个已授权参考项目。把完整 monorepo 直接放在这些参考项目旁边，会让外层容器看起来像多套互不相关的构建树；除非每个工具都携带特殊排除规则，否则仓库级文件系统工具还会遍历参考材料。仅删除生成产物无法消除这种 ownership 歧义。

## 决策

`relay-harness/` 是唯一 tracked 产品/runtime monorepo。本地 `auggie-packages/` 与 `codecortex-rust_副本/` 目录作为同级参考项目保留，并由 Git 忽略。产品源码、文档、包元数据、脚本和构建输出全部归属 `relay-harness/`。

面向 GitHub 的仓库元数据是有意保留的例外。根 `.github/` 继续作为唯一 workflow、Issue policy 与 Dependabot 权威，因为 GitHub 只在此处发现 workflow；其 shell step 从 `relay-harness/` 运行，action-owned path 使用显式前缀。仅用于跳转的根 `README.md` 把访问者引向 runtime 文档，与 runtime 文件逐字节一致的根 `LICENSE` 支持仓库许可证识别，但不形成第二套产品文档权威。外层 `.gitignore` 只管理容器本地参考目录，`relay-harness/.gitignore` 管理 runtime 构建残留。

面向仓库的路径使用同一套外层根坐标。已发布包的 `repository.directory` 值与绝对 GitHub blob 链接都以 `relay-harness/` 开头；monorepo 内的命令、workspace 发现与相对源码链接仍以 runtime root 为起点。workspace 约束会推导并强制这一转换，而不会把 runtime-relative 包路径当成 npm 仓库元数据。

## 考虑过的替代方案

- **在参考项目旁保留扁平 monorepo** — 不采用，因为外层目录是项目容器，而不是 Relay runtime root；普通导航会产生歧义。
- **移动或删除参考项目** — 不采用，因为它们是用户持有且路径稳定的审计输入。
- **把 `.github/` 移入 runtime root** — 不采用，因为 GitHub 不会发现其中的 workflow。
- **在两个根目录分别维护产品文档** — 不采用，因为这会重新形成两套权威；全部产品和 runtime 文档都位于 `relay-harness/docs/`。

## 后果

可见的外层目录包含跳转 README、许可证、`relay-harness/` 与两个本地参考项目。根治理位于 `.github/` 下；外层不保留生成依赖或构建输出。Feature status 记录 `runtimeRoot: "relay-harness"`，CI 与 Dependabot 显式指向该根，仓库检查会拒绝在其外部出现第二套 tracked runtime tree，npm/PyPI 源码链接通过外层前缀解析。
