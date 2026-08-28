# Agent Note: code-index zstd 顺延的证据被推翻——zstd 在 engines 全范围存在

Status: implemented

[English](2026-08-28-code-index-zstd-deferral.md) | 中文

## 问题

chunk 文本压缩编码的顺延——保留 `chunks.text_encoding` 列位、`codec.ts` 只注册 `'plain'`——依据一个陈述性前提：engines 下限 `^22.19.0 || >=24.0.0` 所覆盖的 Node 没有 `zlib.zstdCompress`（zstd 被表述为 v23.8.0 落地、仅从 v24 起可用）。Phase 3 刀 R1 的 spike 被要求固化这条证据链；采集结果反而证伪了前提。Node v22.15.0 以 SEMVER-MINOR 变更把 zstd 带进 v22 LTS 线——"zlib: add zstd support"（[发布公告](https://nodejs.org/en/blog/release/v22.15.0)，PR #52100，commit `4991e5d826`）——v23+ 线则是 v23.8.0。engines 范围覆盖的每个版本都拥有完整 zstd 面：官方 v22.x zlib 文档（[v22.23.2](https://nodejs.org/docs/latest-v22.x/api/zlib.html)）列出 `zstdCompress`、`zstdCompressSync`、`zstdDecompress`、`zstdDecompressSync`、`createZstdCompress`、`createZstdDecompress`、Zstd 常量以及 `ZstdOptions`/`ZstdCompress`/`ZstdDecompress` 类，全部 "Added in: v22.15.0"；当前 [zlib 文档](https://nodejs.org/api/zlib.html) 将同一组 API 记为 "Added in: v23.8.0, v22.15.0"；本地 v24.10.0 运行时探测下八个 zstd 符号全部解析为 function。仓库自身的 shipped 源码已经依赖这套 API——schema-17 持久化编码器在 `packages/session/session-persistence-sqlite/src/compression.ts` 中从 `node:zlib` 导入 `zstdCompressSync`/`zstdDecompressSync`。顺延背后的可用性前提，以及它的恢复条件（engines 下限抬到 24，或引入纯 JS zstd），因此双双作废：下限自写下之日起就高于 22.15.0。

## 决定

顺延终止为"无可用性障碍"：zstd 进入 R4 的正常裁决空间，压缩存储是否成为超大负载的默认路径由 R4 按 experimental 状态容忍度与实测收益定案。本次 spike 不改任何代码——`chunks.text_encoding TEXT NOT NULL DEFAULT 'plain'` 作为保留列对继续存在，`codec.ts` 保持显式注册表（`ChunkTextEncoding` 联合类型加 `decodeChunkText` 拒绝未注册标签），未来的 `'zstd'` 编码就落在这里；`isChunkTextCompressionCandidate` 已拥有 128 字节阈值判定。若 R4 仍选择顺延，唯一还可引用的理由是 Node 将 zstd 系列标注为 Stability: 1 - Experimental——而这一点也被仓库自身接受该状态守护持久数据的先例削弱：[SQLite physical chunk-row compression](../architecture/2026-08-18-sqlite-physical-chunk-row-compression.md) 决定为已持久化的会话行固定了 Zstandard level 3。

同一次 spike 把向量列（R4+）将要依赖的驱动行为固化为永久行为文档 `packages/index/code-index-sqlite/tests/blob-binding.spec.ts`：在 STRICT `BLOB` 列下，`Uint8Array` 绑定并读回 plain `Uint8Array`（往返两侧都不是 `Buffer`）；STRICT 按存储类点名拒绝 TEXT 与数值，且 JS number 绑定为 REAL，连整数 `42` 都以 "cannot store REAL value" 失败；boolean 与 `undefined` 在绑定层即被拒绝、到不了 SQLite 类型检查，`null` 则抵达列位并触发 `NOT NULL`；空 BLOB 与 NULL 是可区分的存储态（`typeof` 为 `blob` 加零长数组，对比 JS `null`）；1KB/64KB/1MB 载荷字节级往返相等；`DataView` 同样可作为 BLOB 绑定，`bigint` 存为 INTEGER——这一对照证实 JS number 绑定为 REAL。

## 已考虑的替代方案

**维持顺延并继续引用"22.19 没有 zstd"。** 否决：前提被三重证伪——v22.15.0 发布公告、v22.23.2 官方 API 文档、v24.10.0 运行时探测——决定记录不能站在已知为假的断言上。

**在本刀直接启用 zstd 压缩编码。** 否决：本 spike 的边界是证据裁决。启用编码属于 R4 向量层刀，与其编解码注册、阈值策略、收益测量同批落地；在此落地会把证据修正混进行为变更。

## 后果

R4+ 从本 note 读到的是修正后的前提：zstd 在 engines 全范围可用，落地路径是 `codec.ts` 注册位加 `zlib.zstdCompressSync`/`zstdDecompressSync`（先例见 `packages/session/session-persistence-sqlite/src/compression.ts`；`'zstd'` 编码已随 schema v6 落地，帧以 base64 TEXT 存储以保持列契约），BLOB 列驱动行为以 `blob-binding.spec.ts` 为准。原恢复条件已死——不要再把 engines 下限当作压缩 chunk 存储的阻塞项引用。

## 验证

`pnpm exec vitest run packages/index/code-index-sqlite/tests/blob-binding.spec.ts` 通过（7 个测试）。node v24.10.0 运行时探测：`zstdCompress`、`zstdCompressSync`、`zstdDecompress`、`zstdDecompressSync`、`createZstdCompress`、`createZstdDecompress`、`ZstdCompress`、`ZstdDecompress` 全部可解析。证据链：[Node v22.15.0 发布](https://nodejs.org/en/blog/release/v22.15.0)（PR #52100、PR #56964 "make all zstd functions experimental"）、[v22.23.2 zlib 文档](https://nodejs.org/docs/latest-v22.x/api/zlib.html)、[当前 zlib 文档](https://nodejs.org/api/zlib.html)。
