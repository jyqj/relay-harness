# Agent Note: SQLite 实时观察缓存与存储介质所有权

Status: implemented

[English](2026-09-03-sqlite-live-observation-cache-and-medium-ownership.md) | 中文

## Problem

两个 SQLite 拥有者缺少其兄弟后端已有的护栏。`SqliteSessionQueryEngine` 在每次搜索时对全部 live 会话的完整日志重新计算指纹——对 header 与每个事件做 `structuredClone`、整体 JSON 序列化、再算一次 SHA-256——因此语料未变化时连续两次搜索仍各付一次全语料字节成本。而 `storage-sqlite` 会打开任何 `user_version` 为 0 或 1 的 SQLite 文件：它把自己的单元表建在外来应用的表旁边并打上标记，静默共写一个不属于它的介质；而 `session-persistence-sqlite` 与 `session-query-sqlite` 都在任何写入之前拒绝外来内容。

## Decision

搜索引擎按 live 会话 id 缓存一份观察结果，并用精确的变更标记校验：`Session.events` 在两次 append 之间复用同一个深冻结数组，因此数组引用相等加上 `sameHeader` 即可证明日志逐字节未变，直接复用缓存的文档与指纹；一次 append 会给该会话新的快照数组，只有该会话被重新计算指纹。观察路径不再克隆输入——live 输入是 store 已深冻结的快照，持久化输入是一次 `inspect()` 私有物化的数组，均为只读——指纹与克隆形态逐字节相同。对账时发现会话离开 live 集合即删除对应缓存条目。不加 `Config` 字段：这是结果不变的实现内部缓存，不是部署选择。

`storage-sqlite` 现在在既有打戳位置同时写入 `PRAGMA application_id`（`STORAGE_SQLITE_APPLICATION_ID = 0x44534852`，延续 Relay Harness 保留序列）与 `user_version`，并在任何写入之前拒绝：其他应用的 application id、已含用户表的未标记文件、或标记为本后端但缺少 `units`／`unit_globals` 元数据表（或携带未识别表）的文件，均以新增的 `StorageErrorCode` `foreign-medium` 失败；布局版本不符仍以 `version-mismatch` 失败。journal-mode pragma 与 DDL 只在这些检查之后执行，与两个会话后端的打开顺序一致。只有零版本的空数据库会被收养。

## Alternatives considered

**用 seq 水位协议做 live 变更检测。** 否决：快照数组引用相等既精确又零成本；水位协议要新增状态去重新推导 store 已经保证的事实。

**检查表名后收养外来数据库。** 否决：共写并打戳外来介质正是缺陷本身；表名检查只会缩小会被覆盖的陌生对象范围。

**保留 `structuredClone` 作为廉价保险。** 否决：它让每次搜索都重新复制每个 live 会话日志的每个事件，而这些输入已冻结或为调用私有；对 store 自己发布的快照做防御性复制违背单一读取路径规则。

## Consequences

语料未变化时重复搜索完全跳过 live 重指纹，且指纹值不变，因此 generation、cursor 与索引内容行为完全一致。`storage-sqlite` 会拒绝由早期构建创建的介质（未标记但已有内容）而不是收养；按预发布立场这些数据库需重建而非迁移。原先的"物化中途受阻"用例变得不可达——含任何外来表的未标记介质现在在物化之前即被拒——因此改为用"删除外来表后可重开"来钉住拒绝后的可恢复性。
