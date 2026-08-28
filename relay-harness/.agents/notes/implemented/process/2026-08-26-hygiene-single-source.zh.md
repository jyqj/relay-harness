# Agent Note: hygiene 门禁单一来源

Status: implemented

[English](2026-08-26-hygiene-single-source.md) | 中文

## 问题

hygiene 检查存在两份。根 `package.json` 的 `hygiene` 脚本串行链接十三个 verify 命令，而 `scripts/run-gates.ts` 持有 `hygieneLeafGates()`——一份带依赖元数据的十门禁重叠清单，被 CI 聚合嵌入。两份清单已经漂移（npm 脚本含 `verify-cordis-config`、`verify-runtime-closure`、`verify-vendored-links`，门禁清单没有），每个新检查都要在两处添加，否则两表面静默分叉。更糟的是该门禁从未真正绿过：十三个成员中的四个（`verify-node-next-types`、`verify-runtime-closure`、`rescope-vendor:check`、`verify-client-packages`）在未改动的树上就失败——本仓库从未有一次 CI 运行跑完，串行脚本的红与清单漂移一样无人看见。

## 决策

`hygiene` 现在是 `tsx scripts/run-gates.ts hygiene`：门禁图中的新 `hygiene` 模式返回 `hygieneLeafGates()` 加上 npm 脚本多出的三项，清单只存在一份。该模式与其他本地聚合一样受本地并发上限（4 worker）约束。四个红成员被修复而非压制：vendored ghostty 源码补上无扩展相对导入缺失的 `.ts` 后缀以满足 NodeNext 声明 emit；`python/sdk-runtime` 声明了 preset 闭包所需的 memory 家族（`rlh-memory`、`rlh-memory-agent`、`rlh-tool-memory`）；`rescope-vendor --apply` 落定了它报告的两处残留编辑（`after-pack.test.js` 的 preset 路径 scope 化与 vendored 市场 lockfile）；`verify-client-packages` 的系统性违规在声明层修复——十一个包把静态 client 输入（`react`、`ui-primitives`、`ui-slots`）移出 `peerDependencies` 改为仅 dev，`rlh-settings`/`rlh-app-boot` 的 `dependencies`+peer+dev 三方声明收敛为 peer+dev 约定。

## 已否决的替代方案

**保留串行脚本并修补其四个失败。** 串行 `&&` 链一次跑一个、无逐项标签、且仍是需要同步的第二份清单。败给门禁图。

**把成员修复推迟到各自变更。** 门禁图变更与成员修复互为验证：一个仍然红色的单一来源门禁证明不了任何漂移消除。合并落地让 `pnpm run hygiene` 一步达到"绿色且单一来源"。

## 后果

`pnpm run hygiene` 以一次依赖感知的执行跑十三个检查并 exit 0；新增检查只需在 `run-gates.ts` 改一行，CI 与本地同时看到。`verify-client-packages` 批次暴露出静态输入规则（静态链接进 client bundle 的输入仅声明 dev）从未全仓执行过——十一个包的修正就是该规则积累的存量。`run-gates.spec.ts` 的模式矩阵加入了 `hygiene`。

## 测试

`pnpm run hygiene` 报告 13 通过、0 失败；`scripts/run-gates.spec.ts` 通过（52 个用例）；受影响包的套件通过（`ui-user-terminal` 166 个用例、desktop `after-pack.test.js` 21 个用例）；`verify-node-next-types` 报告 273 个包在 NodeNext 下编译。
