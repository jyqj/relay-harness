# Agent Note：脏传播与本地索引五阶段管线

Status: implemented

[English](2026-08-28-dirty-propagation-five-stage-pipeline.md) | 中文

## 问题

本地 provider 运行的是四阶段、纯通用的 pass（scan/diff/read/write）：没有任何文件携带解析层行，调用边永远停在未解析状态，导出方的一次编辑让所有导入方的存量 `target_symbol_id` 指向过期符号且没有修复路径。graph 包虽然持有 resolver 与脏重解析写面，却没有任何东西把它们编排起来；parser 里的 Go/Java/C/C++ 抽取器已存在但从未进入 `parseFile` 的分发。

## 决策

增量 pass 变为五个阶段——scan/diff/read、parse、resolve、write（附 test-edge 维护）、脏传播——在 `runRefreshPass` 中以可选的 resolver/graph 对接线，使管线阶段与早期的通用-only pass 共享同一条代码路径。

- **脏传播归属 graph 包**（`src/dirty/`），移植自参考实现的 `dirty_closure.rs` / `dirty_reload_policy.rs` / `indexer_phases/dirty.rs`：`computeExportFingerprint`（仅导出符号、整行排序、SHA-256；无导出为 `null`）、`computeDirtyClosure`（不动点，全局严格大于预算、16 轮硬上限、面向同轮兄弟 re-export 链的内层表面再评估不动点）、穷举的脏重载策略表（`symbols`/`imports` 保留，`callEdges`/`symbolRefs` 清除），以及 `runDirtyPropagation` 编排。
- **指纹比对按构造即写前对写后。** 参考实现的脏阶段在写入之前运行，因此用内存解析产物对照写前 DB。这里写入是阶段 4、脏传播是阶段 5，所以 pass 在提交前从 metadata 账本捕获写前指纹，脏阶段再经 graph facet 读回新值。账本保持唯一权威，这也迫使 writer 支持 `exportFingerprint: null`（导出面清空时清除条目）——否则过期指纹会在之后每次构建中重新点燃闭包。
- **全量构建不携带脏阶段**（与参考实现一致：全量构建不上报传播状态）。同一 pass 内解析的一切都对照新鲜符号完成了绑定，没有需要修复的过期解析。
- **resolver 目录由 provider 持有且长期驻留。** pass 在解析前驱逐本批路径（重写加删除）——即使纯删除批也执行驱逐，否则脏重解析会对照存储已不持有的符号重新绑定——并注册本批新鲜的解析符号，使全量构建能绑定尚未入存的跨文件目标。惰性加载只从存储读取目录缺失的文件；进程重启后由存储本身为目录播种。
- **reader 扩展按重载形态设计。** `callEdgesByFilePaths` / `symbolRefsByFilePaths` 返回完整存量行（写回需要恢复的每个解析事实列），`importerFilesForTargets` 是 `importsByFilePaths` 的反方向，`reexportTargetsForFiles` 供闭包的表面检查使用。resolver 的 `resolveEdges` 对行视图泛型化，使管线从 parse 到 resolve 到 write 持有同一行词汇，无需有损投影。

## 已考虑的替代方案

- **像参考实现那样在写入前跑脏传播** — 否决：本管线提交一个包含已解析行的 delta，写前脏阶段必须预测写后指纹；写前捕获让顺序保持诚实、阶段保持幂等。
- **把脏传播计数暴露在 seam 的 `RefreshSummary` 上** — 暂缓：seam 包为图探索刀冻结，pass 结果（`RefreshPassOutcome.dirty`）已经向包内调用方暴露计数、被提升文件集合与闭包状态。
- **经 Skip/Update 动作表提升** — 否决：参考实现的动作词汇建模的是它的阶段切分；本管线只需要"未重解析且未删除"，闭包直接以 promotable 谓词接收。

## 后果

pass 的 epoch 前进恰好等于其提交次数（delta + 路径集缩小时的 test-edge 重建 + 闭包提升时的一次重解析写回），e2e 按字面审计。Config 新增 `dirtyPropagationMaxFiles`（默认 200）。parser 分发全部十种已内嵌语言，`parseFile` 仅对超限与不支持路径返回 `null`——依赖 Go/Java/C/C++ `null` 回退的调用方将观察到解析层行与真实调用边。自参考实现延续的已知缺口：CommonJS 转发与非 JS/TS 的 re-export 等价物仍以普通 import 存储，这些表面变化不会点燃闭包。
