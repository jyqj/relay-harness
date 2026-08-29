# Agent Note: 代码索引的逐次记录 ID 对齐位置哈希

Status: implemented

[English](2026-08-28-code-index-id-collision.md) | 中文

## Problem

真实语料建索引时触发 `UNIQUE constraint failed: symbols.symbol_uid`（在解析包自身的 32 个源文件上复现 24 处冲突）：`symbolUid` 是内容派生（`file + qname + kind [+ signature]`），不同函数里的同名局部变量（`i`、`child`、`sym`）在相同键上碰撞。参考实现仅靠写入端上游去重容忍该情况。

## Decision

两处改动，均在写入路径：

- `code-index-parser/src/id.ts`——`edgeId`/`refId` 的哈希输入改为参考实现的逐字节等价形式（`kind:file:line_le32:col_le32`，`Buffer.writeUInt32LE`），逐次记录 ID 因此能区分同内容不同位置的记录。`symbolUid`/`chunkId` 保持内容派生，与参考一致。
- `code-index-graph/src/store/writer.ts`——在 `graphRowsForOutcome` 出口做确定性保首去重（先 `symbolId` 再 `symbolUid`；`edgeId`；`literalId`），语义与参考写入端的重复忽略一致。输入顺序即优先级；`buildGraphDelta` 报告 `duplicatesDropped`。

已建的 v2 库带有旧 ID 值（形状不变）；按 pre-release 立场不做迁移——`refresh({ forceRebuild: true })` 重建即可。

## Consequences

真实语料的 parse-to-store 全链零 UNIQUE 违规完成（回归冒烟 spec 钉住该语料）。本修复前所建库的逐次记录 ID 值已变化。

## Alternatives considered

- **原地迁移存量 ID**——否决：索引是带 rebuild-on-mismatch 的派生介质，强制重建更廉价，且 pre-release 无兼容承诺。
- **内容哈希 + 出现计数器 ID**——否决：计数器顺序同样依赖遍历顺序，而位置与参考的键形状逐字节一致。
