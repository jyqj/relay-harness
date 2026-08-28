# Agent Note: 采用 web-tree-sitter 作为代码索引解析依赖

Status: proposed

[English](2026-08-27-web-tree-sitter-dependency.md) | 中文

## Problem

code-index 能力需要正则扫描无法提供的 AST 级抽取（符号、调用边、导入），首个解析包（`@relay-harness/rlh-code-index-parser`）必须选定解析基座。手写解析器不在考虑范围；真正的决策是选哪个 tree-sitter 绑定、内置哪些预构建 grammar 产物，以及哪些参考实现行为要刻意偏离。本 note 记录 `web-tree-sitter` 依赖及其 grammar 供应链的这些决策。

## Proposal

### 依赖 `web-tree-sitter`（WASM tree-sitter 运行时）

按[依赖引入标准](../../implemented/process/2026-07-26-dependencies-over-hand-rolling.md)逐条评判：

- **净删除。** 每种 grammar 一个原生 tree-sitter 绑定意味着九套原生构建/测试矩阵和我们没有能力维护的编译产物供应链；手写递归下降 JS/TS 解析器则意味着数千行完全自营的代码。一个 WASM 运行时依赖加九个只读数据文件替换掉以上全部，而它填充的记录词汇正是索引已定义的契约。
- **健康度。** `web-tree-sitter` 是 tree-sitter 上游项目自己的浏览器/Node 绑定，部署广泛、持续维护；`^0.26.13` 解析到当前版本。传递依赖为零（无运行时依赖）。
- **边界契合。** `Parser.init()` + `Language.load()` + 逐文件 `parse()` 与 `parseFile` 接缝一一对应；用不到的增量解析能力保持未用，也没有围绕它手写残余包装语义。
- **无需硬性允许清单。** [依赖策略](../../implemented/process/2026-07-26-dependencies-over-hand-rolling.md)明确否决了常设允许清单、改为逐 PR 举证；本 note 就是本包的这一份证据。

供应链考量：`web-tree-sitter` **不带任何 install script**（无 postinstall/preinstall）——发布的包是一个 JS bundle 加 wasm blob，`pnpm install` 不会替它执行任何代码。grammar wasm 是**内置的只读数据**而非 npm 包，来源与字节数钉在 `resources/grammars/VERSION`，并由 `tests/grammar-provenance.spec.ts` 强制校验（wasm 魔数、单文件 < 5 MB、总体 < 25 MB 预算）。

### grammar 产物取自官方 grammar release，而非 `tree-sitter-wasms`

npm 上的自然候选 `tree-sitter-wasms@0.1.13` 用 2022 年代的工具链构建 grammar，其 side module 携带旧版 `dylink` 自定义段；`web-tree-sitter` 0.26 的 Emscripten 运行时要求 `dylink.0` 段，在 `Language.load` 处以 "need dylink section" 失败。所有已发布的 `tree-sitter-wasms` 版本都是该格式，目前没有任何 npm 发布的 grammar 集与锁定的运行时兼容。因此内置产物改用官方 `tree-sitter/*` grammar 仓库的 release 构建（携带 `dylink.0`），每个文件的 release 地址与字节数记录在 `resources/grammars/VERSION`。这以 npm 来源可溯性换取产物正确性；若 `tree-sitter-wasms` 将来发布 `dylink.0` 构建，可在一次 vendoring 内切回。

### 偏离参考实现的 blake3 id —— 改用 SHA-256

Rust 参考实现用 blake3 派生 id。本包使用 Node 的 SHA-256（`node:crypto`），输入串构造由 `tests/id.spec.ts` 锁定。理由：blake3 要为"确定性"这一 SHA-256 已具备的属性引入原生或 WASM 依赖，且两个实现的存储永不混用——跨库 id 兼容被明确列为非目标。代价：id 与参考实现逐字节不同；将来若要导入参考实现构建的存储，需要一次显式迁移，而存储的单调 `SCHEMA_VERSION` 机制已为此预留。

### 用逐文件隔离替代缺失的解析超时 API

参考实现用 `parser.set_timeout_micros` 防护病态文件。`web-tree-sitter` 没有中断同步 WASM 解析的机制。替代方案是"隔离"而非"中断"：每次解析是一个独立的 `parseFile` 调用，失败成为一条格式化的 `parseErrors` 记录，WASM parser/tree 在 `finally` 中释放，畸形输入退化为容错遍历而不会中断索引趟。带硬终止的 worker/子进程池是已记录的升级路径，等真实证据需要时再落地。

## Alternatives considered

- **每 grammar 的原生 `tree-sitter` 绑定。** 本阶段否决：为纯 JS 消费方的能力引入九个编译产物与平台矩阵；仅当 WASM 解析吞吐被证不足时重议。
- **WASI tree-sitter 运行时（tree-sitter 0.25 的 WASI 构建）。** 否决：API 面更新，且 grammar 产物兼容性问题依旧存在。
- **锁定仍能加载旧版 `dylink` grammar 的旧版 `web-tree-sitter`。** 否决：那等于锁死一个无人维护的运行时去迁就低质量产物源；换产物源是更小、更正确的动作。

## Risks

- **WASM 上的解析吞吐。** 同步 WASM 解析慢于原生绑定；若真实工作区超出其能力，逃生通道是已记录的 worker/subprocess 升级路径，而不是更换运行时。
- **产物来源是 release feed 而非 npm。** 语法 wasm 来自 `tree-sitter/*` 的 GitHub release；溯源与字节预算已钉死并有测试，但 release 通道中断会阻塞语法刷新，直到移动钉住的版本。
- **id 与参考实现的存储永不互通。** SHA-256 id 与 blake3 id 逐字节不同；导入参考实现构建的存储需要显式迁移。

## Acceptance criteria

- `@relay-harness/rlh-code-index-parser` 可构建、套件以 per-file 100% 覆盖率通过，且共存探针在同一进程内运行 `node:sqlite` 与 web-tree-sitter 解析。
- `resources/grammars/` 恰好包含 9 个内置 wasm 与 `VERSION`，每个都可被锁定运行时加载，且在 provenance 预算内。
- id 确定性与输入串构造由专项测试锁定；不出现 blake3 依赖。
- 上述已知限制在延迟阶段落地前保持体现在包 README 中。

## Links

- 依赖策略：[prefer maintained dependencies over hand-rolling](../../implemented/process/2026-07-26-dependencies-over-hand-rolling.md)
- 供应链归属：[supply-chain and vendor drift](../process/2026-06-11-supply-chain-and-vendor-drift.md)
- Vendoring 决策（为何 grammar 是内置数据而非内置包）：[vendor cordis as source](../../implemented/process/2026-06-11-vendor-cordis-as-source.md)
