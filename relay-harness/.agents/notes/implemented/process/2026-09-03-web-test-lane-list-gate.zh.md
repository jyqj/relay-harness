# Agent Note: apps/web 测试泳道清单获得一致性 gate，knip 覆盖 client tsx

Status: implemented

[English](2026-09-03-web-test-lane-list-gate.md) | 中文

## 问题

apps/web 测试泳道由三份手工维护、必须步调一致的清单命名：`tsconfig.host.json` 承载 host 面规格（`apps/web/tests/*.e2e.ts` 等要启动 host spine 并读取其 Context merge，client 程序不能持有它们），`apps/web/tsconfig.json` 把这些文件从 client 程序中排除，`scripts/run-web-snapshots.ts` 排定串行浏览器属主。此前没有任何检查保证三者一致，一条规格可以无声逃逸 typecheck：`tests/desktop-chrome.e2e.ts` 在 client `exclude` 里，却从未进入 host `include`，不被任何程序编译。另一方面，`knip.json` 的 fallback workspace（`packages/*/*`）只写了 `.ts` glob，所有 client 包的 `.tsx` 源码和 `*.spec.tsx` 测试对死代码分析完全不可见。

## 决策

`scripts/web-test-face.spec.ts` 用 `ts.readConfigFile` 解析两份 tsconfig（读取原始 glob 而非解析后的文件名），断言：client `exclude` 与 host 的 `apps/web/tests` include 条目相等，唯一例外是 `tests/support.ts`——它被两个面的规格共同引用，无论是否排除都会因 import 进入任一程序；同时三份清单里的每个条目都必须在磁盘上存在。该 gate 抓到一处漂移，修复方式是把 `apps/web/tests/desktop-chrome.e2e.ts` 加入 host include——这条规格首次被 typecheck。

`knip.json` 为 41 个拥有 `.tsx` 文件但没有显式 key 的包补充显式 workspace key（37 个 client UI 包、`client/locale`、`extensions/ui-cordis`、`session-query/session-log-export`、`test-support/client-runtime`），entry 写 `tests/**/*.spec.tsx`（`ui-cordis` 的 client 规格是 `.ts`，写 `spec.ts`），project 写 `src/**/*.{ts,tsx}` 与 `tests/**/*.{ts,tsx}`。`pnpm run knip` 保持零 finding、零 configuration hint。

## 已考虑的替代方案

**在 fallback workspace 上加宽 `.tsx`/e2e/snapshot glob。** 拒绝：knip 脚本带 `--treat-config-hints-as-errors`，通配 glob 在约 150 个 fallback 包的大多数里零匹配，会产生 931 条 configuration hint 直接打挂 hygiene 门。按拥有 tsx 的包补显式 key 也符合该文件既有风格——每个 fallback 例外早已拥有自己的 key。

**不加 gate，依赖人工评审。** 拒绝：清单已经向两个方向漂移过（一条逃逸的规格），且每个新 web 测试都在手工重造同样的风险。

## 后果

新的 host 面 web 规格漏掉任一 tsconfig 清单、清单条目拼错、串行 runner 文件被删，现在都会让 `scripts/web-test-face.spec.ts` 失败，而不是无声逃逸 typecheck。gate 看不到第三种失败形态——host 面规格两份清单都不加会被 root 进 client 程序——因为 client 面合法持有未列出文件（`assembled-boot.ts`、各 `.snapshot.ts` 规格）；这个洞仍靠评审把守。knip 现在能看到 client tsx 源与 spec.tsx entry，但它当前的全量报告只对根 workspace 呈现 unused files：client 包的 `src/**` 作为 workspace 依赖的 entry 面进入模块图，entry 级文件不可能被报 unused。因此加宽后的覆盖今天报告零新 finding，同时为 knip 的未来行为补上了配置缺口。

## 相关

- [统一 Agent Note 格式](2026-07-05-uniform-agent-note-format.md)
