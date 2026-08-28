# Agent Note: code-index zstd deferral evidence reversed — zstd exists across the engines range

Status: implemented

English | [中文](2026-08-28-code-index-zstd-deferral.zh.md)

## Problem

The chunk-text compression deferral — `chunks.text_encoding` column kept in reserve, `codec.ts` registering only `'plain'` — rested on a stated premise: the engines floor `^22.19.0 || >=24.0.0` runs on a Node whose `zlib.zstdCompress` does not exist (zstd framed as landing in v23.8.0 and available only from v24). The Phase 3 R1 spike was asked to fossilize that evidence chain; collecting it disproved the premise instead. Node v22.15.0 carried zstd into the v22 LTS line as a SEMVER-MINOR change — "zlib: add zstd support" ([release announcement](https://nodejs.org/en/blog/release/v22.15.0), PR #52100, commit `4991e5d826`) — while the v23+ line got it in v23.8.0. Every version the engines range covers therefore has the full zstd surface: the official v22.x zlib documentation ([v22.23.2](https://nodejs.org/docs/latest-v22.x/api/zlib.html)) lists `zstdCompress`, `zstdCompressSync`, `zstdDecompress`, `zstdDecompressSync`, `createZstdCompress`, `createZstdDecompress`, the Zstd constants, and the `ZstdOptions`/`ZstdCompress`/`ZstdDecompress` classes, all "Added in: v22.15.0"; the current [zlib documentation](https://nodejs.org/api/zlib.html) records the same APIs as "Added in: v23.8.0, v22.15.0"; and a probe on the local v24.10.0 runtime resolves all eight zstd symbols as functions. The repository itself already depends on this API in shipped source — the schema-17 persistence encoder imports `zstdCompressSync`/`zstdDecompressSync` from `node:zlib` in `packages/session/session-persistence-sqlite/src/compression.ts`. The availability premise behind the deferral, and its recovery condition (raise the engines floor to 24, or adopt a pure-JS zstd), are both void: the floor has been above 22.15.0 since it was written.

## Decision

The deferral ends as "no availability obstacle": zstd moves into R4's ordinary decision space, and whether compressed storage becomes the default path for oversized payloads is decided there on experimental-status tolerance and measured benefit. This spike changes no code — `chunks.text_encoding TEXT NOT NULL DEFAULT 'plain'` stays as the reserved column pair, and `codec.ts` keeps the explicit registry (`ChunkTextEncoding` union plus `decodeChunkText` rejecting unregistered tags) that a future `'zstd'` encoding joins; `isChunkTextCompressionCandidate` already owns the 128-byte threshold gate. If R4 still defers, the only surviving reason to cite is Node marking the zstd family Stability: 1 - Experimental — and even that is weakened by the repository's own precedent of accepting the status for durable data: the [SQLite physical chunk-row compression](../architecture/2026-08-18-sqlite-physical-chunk-row-compression.md) decision pins Zstandard level 3 for persisted session rows.

The same spike fixed the driver behavior the vector column (R4+) will build on, as a permanent behavior record in `packages/index/code-index-sqlite/tests/blob-binding.spec.ts`: under a STRICT `BLOB` column, `Uint8Array` binds and reads back as a plain `Uint8Array` (never `Buffer`, on either side of the round trip); STRICT rejects TEXT and numeric storage classes by name, with JS numbers binding as REAL so even integral `42` fails with "cannot store REAL value"; booleans and `undefined` are refused at the binding layer before SQLite type checking, while `null` reaches the column and trips `NOT NULL`; an empty BLOB and NULL are distinct storage states (`typeof` = `blob` with a zero-length array, versus JS `null`); 1KB/64KB/1MB payloads round-trip byte-for-byte; `DataView` also binds as BLOB, and `bigint` stores as INTEGER — the contrast that confirms JS numbers bind as REAL.

## Alternatives considered

**Keep the deferral and keep citing "22.19 has no zstd".** Rejected: the premise is disproved three ways — the v22.15.0 release announcement, the v22.23.2 official API documentation, and the v24.10.0 runtime probe — and a decision record cannot stand on an assertion known to be false.

**Enable zstd compression in this increment.** Rejected: this spike's scope is the evidence ruling. Enabling the encoding belongs to the R4 vector cut together with its codec registration, threshold policy, and benefit measurement; landing it here would fold an evidence correction into a behavior change.

## Consequences

R4+ reads this note for corrected premises: zstd is available across the entire engines range, the landing path is the `codec.ts` registry plus `zlib.zstdCompressSync`/`zstdDecompressSync` (precedent in `packages/session/session-persistence-sqlite/src/compression.ts`; the `'zstd'` encoding has since landed in schema v6, storing the frame as base64 TEXT so the payload keeps the column contract), and the BLOB column driver behavior is pinned by `blob-binding.spec.ts`. The original recovery condition is dead — never again cite the engines floor as the blocker for compressed chunk storage.

## Testing

`pnpm exec vitest run packages/index/code-index-sqlite/tests/blob-binding.spec.ts` passes (7 tests). Runtime probe on node v24.10.0: `zstdCompress`, `zstdCompressSync`, `zstdDecompress`, `zstdDecompressSync`, `createZstdCompress`, `createZstdDecompress`, `ZstdCompress`, `ZstdDecompress` all resolve. Evidence chain: [Node v22.15.0 release](https://nodejs.org/en/blog/release/v22.15.0) (PR #52100, PR #56964 "make all zstd functions experimental"), [v22.23.2 zlib docs](https://nodejs.org/docs/latest-v22.x/api/zlib.html), [current zlib docs](https://nodejs.org/api/zlib.html).
