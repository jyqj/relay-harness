# Agent Note：本地代码索引 Provider —— 四层折叠到一个 seam 之后

Status: implemented

[English](2026-08-27-code-index-local-provider.md) | 中文

## 问题

本地代码索引能力此前已有 Service Definition（`ctx.codeIndex`）、检索引擎与派生 SQLite 存储，但缺少 Service Provider：没有组件遍历工作区、判定变更、切片被接受的文件，或把存储接到检索上。这些层各有归属；在它们装配为一个 provider 之前，`tool-code-index` 的工具永远无法作答。

## 决策

新增 `@relay-harness/rlh-code-index-local`，提供 provider 插件（`CodeIndexLocal extends CodeIndex`）与各层独立模块，使每个关注点可单独测试：

- **Scanner** 逐字转录参考实现的默认硬排除（15 条）与 include（27 条）glob 数组，叠加三层排除并集（硬排除 ∪ 配置 ∪ 解析后的根 `.gitignore`），下降前剪枝目录，统计拒绝对其遍历的目录符号链接，并为每个有产出的目录产出一个批次。
- **Diff** 把两个阶段分开：`planSnapshotDiff` 仅凭已存 mtime+size 判定；`confirmChangedByHash` 对候选重读一次内容哈希，使 touch 假阳性与 mtime 抖动保持 Unchanged。扫描后读取前消失的候選落入同一 delta 的删除半区，注入式 IO 套件确定性地钉住每条竞态分支。
- **Chunker** 应用参考实现 `default_chunk_line_budget` 的 80 行预算，打上 `generic`/0.5 解析词汇，用致命 UTF-8 解码门控二进制载荷，超限文件保留为"只有行没有 chunks"的记录且 summary/excerpt 仍取自首窗。
- **Provider runtime** 持有折叠语义（并发 refresh/lazy 调用者共享唯一在途 pass）、提交后按 tier 重绑 cache/port/engine、作答时注入 epoch，以及 `forceRebuild` 的删库重建。工具结果失效经防抖汇入该折叠；可选的递归 watcher 只是延迟优化，失败通过 `status().degraded` 响亮但可存活地降级。

存储路径默认 `<rlhHome>/index/code-index-<hash12>.sqlite3`，对工作区 realpath 取哈希，避免多 checkout 部署互踩——这明确是计划中可配置 storage-root 布局之前的过渡形态。`last_refresh` 元数据键持久化提交后的 summary，重启后无需重走一遍即可报告新鲜度。

真实组合测试从 test-only cordis.yml 经真实 Loader 启动 provider、两个前置服务与工具消费者，然后在盘上修改并删除 fixture 文件，经测试专用的 `refreshInternal()` 钩子确定性冲刷：gitignored 树内的诱饵永不出现，新内容立即参与排序，删除文件消失，epoch 恰好比之前多前进一次。

## 后果

本包闭合了 Phase 1 的兄弟链（[seam 脚手架](2026-08-27-local-code-index-seam.md)、[存储读写](2026-08-27-code-index-sqlite-writes-reads.md)、[工具消费者](2026-08-27-code-index-tools.md)）：该能力的每个角色现在都有归属并接入了同一组合。

覆盖率纪律逼出了真正的行为 seam：mock `node:fs` 会让整文件的执行对 v8 覆盖率不可见，因此运行时行为套件放在无 mock 的 spec 文件里，被 mock 的文件只钉构造期拒绝路径；注入式 `RefreshPassIo` 存在的原因是真实"扫描→读取"间的删除竞态无法在活文件系统上确定性复现。唯一的 `/* v8 ignore next */` 覆盖脱离调用的 stale-pass 失败日志闭包——它由 timer 在没有任何 await 调用者时分发。

注册缺口刻意保留：生成 catalog 针对新 `ctx.codeIndex` 实现包的六点清单与分组 README 索引收口归主会话，tsconfig.host.json 聚合接线同样如此。

## 备选方案

- **以锁保护的逐工具即时刷新替代折叠** — 否决：工具层已经会以 `INDEX_TOOL_REFRESH_IN_PROGRESS` 快速失败而"不排队等折叠"，seam 契约把折叠指名为所有权语义；再放一把锁是在折叠点之下重复它。
- **按工具参数做路径级失效** — 否决：要求信任每个工具如实上报触及路径，相比 mtime+size 快路径几乎无收益，却让一个说谎的工具变成静默过期。
- **watcher 作为正确性来源** — 被 seam note 直接否决：事件只是提示，遍历才是权威，因此 watcher 失败降级而不是让组合失败。
