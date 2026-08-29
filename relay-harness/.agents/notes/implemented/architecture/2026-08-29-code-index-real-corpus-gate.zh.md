# Agent Note：真实仓库 Code Index Corpus 门禁

状态：已实现

[English](2026-08-29-code-index-real-corpus-gate.md) | 中文

## 问题

检入的检索 fixture 已证明算法与增量生命周期行为，但不能证明完整 scanner/parser/SQLite/search 栈可在真实中大型 checkout 上完成。一次性绝对路径 benchmark 无法在仓库拉平后复现、无法进入 CI，还会诱导把参考仓库源码复制进 Relay。产品同时需要 full-index 时间、定域增量 p95、搜索 p50/p95、文件/chunk/parser 覆盖及可验证 Recall@K，而不能把单机结果升级成普适容量声明。

## 决策

`scripts/code-index-external-corpus.ts` 是通过公开 runtime 执行的 benchmark。它从自身模块路径向上发现 pnpm workspace，先解析显式环境变量，再尝试 cwd/workspace 相对候选，不假设当前双层 checkout 结构。Corpus 定义和相关性判断位于 `scripts/corpora/code-index-real-repositories.json`；manifest 只包含路径与判断，绝不包含参考源码。

Relay monorepo 在每个 checkout 中都存在，因此是 required CI corpus。CodeCortex Rust 与恢复后的 Auggie checkout 为 optional：普通 CI 缺失时跳过；显式选择或提供环境根后，缺失即失败。`pnpm run eval:code-index:corpus:ci` 因而能在干净 Relay checkout 上确定执行，也能在已授权 corpus worker 上扩展。

每次运行独占临时 SQLite 数据库。全量刷新、质量 query、重复搜索与七次定域提交都经过 `LocalCodeIndexRuntime`。增量测量使用一个碰撞检查过的临时源文件，并在 `finally` 删除/reconcile；除此之外 corpus 源码只读。报告从派生数据库查询文件/chunk 数、parser-tier 分布与无 chunk 文件数。生产 pipeline 中 parser 异常是致命且原子的，因此完成的运行报告 `parserErrors: 0` 与 `parserFailurePolicy: fatal-atomic`；parser 异常会让门禁失败，而不是虚构逐文件计数。

## 实测证据

2026-08-29，真实 Relay checkout 完成 8,256 文件、85,472 chunks，致命 parser 错误为零。全量索引 120.65 s；七次定域更新 p95 为 80 ms；重复搜索 p50/p95 为 0.051/0.087 ms。五个相关性 case 的 Recall@5 为 0.80、MRR 为 0.60。Parser tier 为 generic 4,395、semantic 3,859、tree-sitter 2；一个文件没有 chunk。

可选的已授权 CodeCortex Rust checkout 完成 366 文件、5,523 chunks，致命 parser 错误为零。全量索引 7.13 s；定域增量 p95 28 ms；搜索 p50/p95 0.050/0.080 ms。五个相关性 case 的 Recall@5/MRR 均为 1.00。Parser tier 为 generic 129、semantic 235、tree-sitter 2；所有索引文件都有 chunk。JSON 证据检入 `docs/benchmarks/`，没有检入 CodeCortex 或 Auggie 源码。

## 考虑过的替代方案

- **把参考仓库复制进测试 fixture**——否决；这会复制源码、产生许可证/更新风险，而且测的是冻结的人工副本，不是已授权 checkout。
- **硬编码 `/Users/...` corpus 路径**——否决；拉平仓库、CI 与其他开发者会在索引前直接失败。
- **强制所有外部 corpus**——否决；公开 CI 不能假设私有或本地恢复 checkout；显式选择仍会让 optional corpus fail-closed。
- **修改并恢复 corpus 现有文件**——否决；中断可能弄脏或损坏参考 checkout；唯一临时 probe 拥有有界清理契约。
- **把 generic-tier 文件算作 parser 错误**——否决；generic 是不支持/超限输入的有意 fallback。致命 parser 错误会中止原子 pass 并让 runner 失败。

## 后果

Relay 现在拥有可重复的真实仓库证据与可执行 CI 边界，不再只有 fixture 声明。Required Relay gate 比单元测试昂贵，应放入专用 benchmark job，而非每个快速 shard。已授权 checkout 存在时，optional corpus 结果提高代表性。阈值是有意放宽的跨机器回归上限；检入测量仍是带日期的硬件观测，不是所有仓库或机器的性能承诺。
