# Agent Note：legacy-API 退出 guard 以一份 allowlist 对照源码文本

Status: implemented

[English](2026-09-20-legacy-api-exit-guard.md) | 中文

## Problem

[ADR-0007](../../../../docs/adr/0007-legacy-api-exit-conditions.md) 记录了哪些业务域仍在两个客户端方法面上应答，但纯文字表格拦不住新增的 API 代理处理器，也拦不住被遗忘的退役；无人看管之处正是重复逻辑生长之处。

## Decision

`scripts/legacy-api-exit.ts` 以纯文本方式提取三个事实并相互比对：api-remotes 客户端组装层的 `/remote` 默认导入、API 代理的 `RpcMethodMap` 键、连接层的 `PRIVILEGED_METHODS` Set 字面量。断言有三条：计算出的重复域集合等于 `DUPLICATED_DOMAIN_ALLOWLIST`；已挂载的每个 remote 贡献都出现在 `REMOTE_WIRE_TABLE` 中；fence 清单等于钉住的 `EXPECTED_PRIVILEGED_METHODS`。`scripts/legacy-api-exit.spec.ts` 在 `pnpm run test` 内通过 `collectExitViolations` 校验真实工作树（沿用 `scripts/ci-workflow.spec.ts` 的先例），并用合成输入证明每个失败方向：未入 allowlist 的新重复、面已消失的过期 allowlist 条目、双向的 fence 漂移，以及忽略注释与 type-only re-export 的提取器。

## Alternatives considered

- **用 TypeScript 编译器做 AST 解析。** 三个锚点（默认导入行、带引号的 map 键、一个 `Set` 字面量）都很稳定，负例测试又钉住了提取器；引入编译器管线没有换来任何东西。
- **挂在 `doc-sync` 下的文字门禁。** 文档检查无法把三个源文件相互比对，也达不到 `pnpm run test` 的执行时点。
- **只钉住 fence 清单。** 仅钉清单仍挡不住第三个面悄悄出现；allowlist 比对才把 ADR-0007 的表格变成被执行的不变量。

## Consequences

- 迁移一个域意味着在同一变更中删除落选面并移除 allowlist 条目；过期条目使 `pnpm run test` 失败。
- 对表中 remote 域新增 API 代理处理器，或 remote 贡献未入表，都会失败，直到决策被记录。
- 重命名或重构三个锚定文件中的任何一个，都需要在同一变更中更新脚本的路径或提取器。
- 提取器读取文本，因此破坏锚点的格式变更会以指名漂移文件的 guard 失败呈现，而不是被静默接受。
