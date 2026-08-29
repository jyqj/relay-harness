# Agent Note: Duplication 门禁的范围与阈值

Status: implemented

[English](2026-08-26-duplication-gate-scope-and-threshold.md) | 中文

## 问题

`duplication` 门禁有两个缺陷。其一是范围：`jscpd --config .jscpd.json packages scripts` 加 `format: ["typescript", "tsx"]`，使全仓 181 个 JavaScript 文件——包括 `apps/desktop` 3.5 万行的主进程——完全游离在 clone 检测之外。其二是退出语义：配置里的 `"exitCode": 1` 在 jscpd 5 中含义是"发现任何 clone 即非零退出"；`packages`+`scripts` 上已存在 33 处 clone，因此 `pnpm run duplication` 在未改动的树上就 exit 1。本仓库从未有一次 CI 运行跑完（唯一一次被取消），这个"常红"门禁从未被观察到。

## 决策

门禁扫描 `packages scripts apps`，`format: ["typescript", "tsx", "javascript"]`、`pattern: "**/*.{ts,tsx,js,jsx}"`，忽略 `apps/desktop/vendor/**`（预编译第三方 drop，非自有源码），并以 `"threshold": 1` 取代 `exitCode`：仅当重复行超过扫描总行数的 1% 才非零退出。当前总量 0.49%（150 处 clone；仅 JavaScript 一项就是 3.28%/117 处，集中在 `apps/desktop`，TypeScript 为 0.11%），门禁绿色并留有约 2 倍余量，重复率持续增长即转红。按格式分列的统计表让 desktop 的 JavaScript 簇在每次运行中保持可见。

## 已否决的替代方案

**保留 `exitCode: 1` 并先消除全部 150 处 clone。** desktop JS 去重是以周计的迁移，期间常红门禁不提供任何信号。败给阈值——它现在就恢复可用的边界。

**等 desktop 迁移完再纳入 apps。** 那会重新制造本变更要消除的盲区。败给"纳入 apps 并忽略 vendor drop"。

## 后果

clone 检测从此覆盖承载 `apps/desktop` git 子系统的无类型 JavaScript 世界，那里未来的平行实现会以门禁压力显形，而不是无形累积；测得的 3.28% JavaScript 重复率就是未来 desktop 抽取要消化的量化存量。1% 阈值是棘轮而非上限：desktop 去重落地后，应把它降向 TypeScript 基线（0.11%）。在那之前，包络内的重复增长不会被门禁察觉——这是恢复信号所付出的已接受代价。

## 测试

`pnpm run duplication` 在当前 0.49% 下 exit 0；`npx jscpd --config .jscpd.json --threshold 0.1 packages` exit 1，证明越界条件会触发。
