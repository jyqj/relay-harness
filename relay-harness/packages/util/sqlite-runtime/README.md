# SQLite runtime

English | [中文](README.zh.md)

`@relay-harness/rlh-sqlite-runtime` owns lazy synchronous loading of Node's SQLite builtin. Database schemas, transactions, connections, and close lifetimes remain with the calling adapters.

## Contract

`loadNodeSqlite()` caches the builtin after a successful load. During the synchronous builtin load only, it filters the exact SQLite experimental stability notice and delegates every other warning unchanged. It restores `process.emitWarning` before returning or throwing. A failed load remains retryable. Importing this package does not load SQLite.

## Model Experience

None, as this utility only loads a Node builtin; its callers own every tool and storage contract.

#### KV Cache effect

None; this package neither assembles nor sends model requests.

## Known Limitations and Deferred Work

- **Initialization only** — the helper does not hide database errors, filter later warnings, change Node's SQLite stability guarantees, or coordinate database owners. It relies on the repository's supported Node versions providing `process.getBuiltinModule`.
