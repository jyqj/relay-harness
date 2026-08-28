# Agent Note: Code-index SQLite 写入与读取——epoch 精确事务对接检索端口

Status: implemented

[English](2026-08-27-code-index-sqlite-writes-reads.md) | 中文

## Problem

存储切片（[SQLite store](2026-08-27-code-index-sqlite-store.md)）只能准入数据库，尚未导出任何写路径与查询路径，其上的一切消费方——provider 增量、排序引擎的 `RetrievalPort`——都被三个必须一次做对的决策挡住：缓存失效时钟究竟何时推进；应用层维护的 FTS 镜像相对基表行以什么顺序触碰；扫描预算在 store 与 search 之间归属何处。任何一处出错都是静默失败：漏掉的 bump 会继续返回陈旧 chunk，顺序颠倒的镜像删除会让 FTS 行指向被复用的 rowid，而 store 侧强加的预算永远无法与拥有用户可见 `truncated` 结论的 lane 共享。

## Decision

把参考实现的写入/检索模型移植进 `packages/index/code-index-sqlite` 的四个模块，并按本 schema（六表、暂无 symbol 层、语言挂在文件行）适配：

- **epoch 折叠进所属事务**（`src/epoch.ts`）。`bumpIndexEpochOnceInTx` 包裹 `BEGIN IMMEDIATE … COMMIT`，在事务内执行调用方的语句，并在 COMMIT 前最后一条语句推进 `index_epoch`；任一失败整体回滚——计数也不例外。证据时钟按 `epoch_rules.rs` 冻结；P3 切换通道时无需改动该包装器。`assertExactAdvance` 以声明通道审计提交；`readEpochs` 对缺失或不可解析的账本行抛错（复用编解码器的 `CODE_INDEX_SCHEMA_VERSION_UNSUPPORTED`——同为"介质状态未被登记"），绝不静默回零，因为消费方用这些值做缓存键。
- **writer 镜像跟随基表行生命周期**（`src/writer.ts`）。一个 delta 就是一个带 bump 的事务。镜像删除先于基表删除、经仍存活的基表行解析 rowid 子查询完成；插入捕获最外层语句的 `lastInsertRowid`（触发器内插入不会扰动它）按对齐 rowid 重镜像；removal 按 200 变量的参考预算分批。upsert 计入替换而非 removal。
- **reader 逐字实现 port**（`src/reader.ts`），对齐 `packages/index/code-index-search/src/port.ts`：参考列权重的 bm25、scope 渲染为 SQL 并转义 LIKE 元字符、无 scope 的 grep 扫描按 `rowid DESC` 流式执行、skip 名单在任何解码成本之前通过、预算策略完全留给 visitor 一侧。两处 schema 适配：`symbolNamesByTokenSubstring` 返回空（尚无 symbols 表），语言从 `files` join。
- **缓存键内嵌时钟**（`src/cache.ts`）。槽位是 `(index_epoch, chunk_rowid)` 字符串，不存在会被遗忘的手动失效；容量是本包自主的分层表（tiny/small/medium/large = 128/256/384/512），作为归属决策记入 README。降级结果纪律由 API 形状承担：`setIfFresh` 必须传入新鲜度对，`readErrors` 非空的调用点想写也写不进。

## Consequences

落地内容：跨批量规模与重开场景验证的 exactly-once epoch 语义；零残留、零计数漂移的原子回滚；经镜像明文覆盖中英文 FTS MATCH；并用真实搜索引擎端到端跑通 port 对齐（lexical + 两段 grep + 显式路径 scope）。测试仅以 devDependency 引入 search 包——运行时代码只经 `import type` 引用它，因此发布包不新增 peer 边、也不成环。包级 oxlint、export-JSDoc、vitest 含覆盖率（每文件 100%）与切片类型检查全部通过；全仓 build/lint 当前只在兄弟在途包内失败（同样说明见 [store note](2026-08-27-code-index-sqlite-store.md)）。连同理由一并延后：压缩编码（codec 契约已拒绝之）、证据通道写入（P3）、symbol 层检索方法（P2）。

## Alternatives considered

- **版本标记条目 + 提交时清扫**——否决：每次 bump 都清扫缓存槽，等于重新引入时钟本要消除的簿记；漏扫正是本设计使其不可达的静默陈旧类 bug。
- **预算记账放进 reader**——否决：port 把扫描成本交给 store、把截断策略交给负责合并两段扫描并持有用户可见 `truncated` 标志的引擎；两半职责在存储层重复必然分叉。
- **像 `file_paths_fts` 那样用触发器同步 FTS**——对 `chunks_fts` 否决：逐 chunk 的 AFTER INSERT 触发器照样运行在每个写路径里，却把镜像契约藏了起来；显式语句让对齐规则在拥有它的 writer 旁边保持可见、可测。
