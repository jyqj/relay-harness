# Agent Note: Code-index SQLite 存储库——fail-closed 准入与派生介质原地重建

Status: implemented

[English](2026-08-27-code-index-sqlite-store.md) | 中文

## Problem

本地代码索引能力需要先落定磁盘介质，provider 增量才能对着冻结的 schema 开发，而不是在开发中途发明存储。难点在准入策略：同一路径必须对外来应用抛错拒绝（错误配置的路径不能被悄悄改写），却又不能让 schema 漂移劫持已认领的索引——因为其中每个字节都可以从工作区重建。参考实现两者兼得，但首次移植必须为每种失败形态裁决它落在张力的哪一侧，并把该裁决固化成未来工具可路由的稳定错误码。

## Decision

新建 `packages/index/code-index-sqlite`，作为纯存储仓库：无 service 类、无 Config、无插件入口——只有 `openCodeIndexDatabase`、DDL 常量与 chunk 文本编解码器。三个契约点：

- **身份 fail-closed，内容原地重建。** 非零的外部 `application_id`，或未登记 id 下的用户表，在任何 mutating pragma 之前抛 `CODE_INDEX_DB_FOREIGN_APPLICATION`。文件一旦被认领，版本漂移或未知表触发 `resetDerivedSchema`（全部 DROP、`user_version` 归零）后重建——与 memory 后端 canonical 库的前置断言次序一致，只是用重建替代迁移，因为索引是派生数据。
- **FTS 影子表属于具名清单。** 准入扫描枚举普通用户表，而每张 FTS5 虚拟表会物化五张影子表（`*_data`/`_idx`/`_content`/`_docsize`/`_config`）。known-set 检查显式列出全部；把影子表当"未知"会导致每次打开都重建健康库——这一点由测试抓住，而非靠 review。
- **编解码器从第一天起带编码标签。** chunk 文本按 `(text_encoding, text)` 列对存储；遇到未注册标签 `decodeChunkText` 抛 `CODE_INDEX_SCHEMA_VERSION_UNSUPPORTED` 而非猜测。128 字节的压缩资格阈值现以纯函数形式移植，供压缩层复用经测试的常量。

epoch 元数据（`index_epoch`/`evidence_epoch`，播种 `'0'`）随本刀落地：现在冻结 schema 与词汇很便宜，等 seam 之上的缓存键依赖 epoch 后再补就很贵。

## Consequences

落地内容：六表 DDL（STRICT 行源、chunks 级联删除、unicode61 的 chunk/文件文本 FTS 加触发器自维护的 trigram 路径 FTS）；owner-only 文件创建（`0700`/`0600`），`EEXIST` 静默通过；所有失败路径先关句柄再抛错。刻意未做任何读写——provider 落地前 epoch 保持 `'0'`、FTS 行保持为空，因此 README Known Limitations 逐一列明缺席模块而不是暗示就绪。全仓 build/lint 门禁当前因同级在建的 `code-index-search` 包而失败，故本刀以 tsc 图谱、包级 oxlint 与覆盖率门禁的 vitest 完成验证。

## Alternatives considered

- **像 canonical memory 库那样前向迁移**——拒绝：迁移的存在意义是保住不可再造的持久状态；为索引字节维护版本链相对确定性的整体重建没有任何消费收益。
- **版本匹配但含未知表时也 fail-closed**——拒绝：写入中断或 `.sqlite-wal` 轮转崩溃后的残留碎片应当自愈，而不是把工作区索引变砖。
- **把压缩信息编进 payload 前缀**——拒绝：编码并入文本列会把读取端耦合到格式嗅探；分列存储保持 STRICT 类型与逐列投影完整。
