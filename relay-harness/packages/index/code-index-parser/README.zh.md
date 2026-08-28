# @relay-harness/rlh-code-index-parser

[English](README.md) | 中文

Relay Harness 代码索引能力的 tree-sitter 解析层：基于内置的 web-tree-sitter grammar 与一层无 grammar 的正则通道，把单个文件的文本转换为派生索引所存储的抽取记录——符号、导入、调用边与字符串字面量——同时提供确定性的 id 生成、导入路径解析与符号感知分块。

本包属于 code-index 能力：

| 包 | 角色 |
|---|---|
| `@relay-harness/rlh-code-index` | Service Definition：抽象服务、词汇类型、仓库规模分层 |
| `@relay-harness/rlh-code-index-parser`（本包） | 解析层：grammar 加载、逐文件抽取记录、分块 |
| `@relay-harness/rlh-code-index-sqlite` | 存储仓库：schema、按 epoch 递增的写入、检索端口适配 |
| `@relay-harness/rlh-code-index-search` | 检索领域引擎：预选、多通道、融合、重排 |
| `@relay-harness/rlh-code-index-local` | Service Provider：组装在 `ctx.codeIndex` 之后的扫描/差量/分块管线 |
| `@relay-harness/rlh-tool-code-index` | Consumer：面向模型的 search/status/refresh 工具 |

## 解析

`parseFile(relPath, text, options)` 按照完整的参考扩展名表对路径做语言判别；仅在文件超过 `maxFileBytes` 或扩展名没有对应解析器时返回 `null`——调用方恰在这两种情况下回退到通用行分块。抽取失败从不抛出：以 `"<file>: <message>"` 的格式落入 `parseErrors`（由 `parseErrorCount` 计数），并保留失败前已抽取的记录。

walker 覆盖全部已内嵌语言并按参考实现分层：JS/TS 家族（JavaScript、TypeScript、TSX、JSX；`jsx` 使用 JavaScript grammar 解析）与 Python 为 `semantic`（置信度 0.85），Go、Java、C/C++ 为 `tree-sitter`（0.7）并各有专属 walker 抽取符号与 imports。JS/TS walker 额外抽取 function/generator/class/method/variable 符号（含 TypeScript 参数与返回类型）、ES `import`/`export`/`export ... from` 以及两种绑定形态的 CommonJS `require()`、调用边（member、direct、optional-chain、constructor；AST 结果与正则兜底按 `(line, startCol)` 去重合并），以及 3–160 字节窗口内的字符串字面量。framework role 覆盖 React hooks/components、middleware、NestJS controller/service，以及把 `@Get` 风格装饰器标记为 route handler。延迟导出回填把 `export { local as exported }` 与 `export default local` 绑定到符号，并把导入绑定的两步转发标记为 re-export。

没有内置 grammar 的八种语言——C#、PHP、Ruby、Swift、Kotlin、Dart、Scala、Lua——由 spec-driven 抽取器以 `heuristic`（置信度 0.5）解析：每语言的声明正则产出符号（namespace/package 上下文进入限定名；缩进或带限定符的函数记为 method；跨度止于估算值而非解析出的函数体），每语言一条导入正则填充导入记录，且每次解析同时产出同文件调用边——裸名 callee 命中文件内 function/method 的每个 `name(` 调用点，经控制流关键字 blocklist、声明行与自环跳过、最内层包含 caller 三重防护。

Vue 与 Svelte 单文件组件以 `heuristic`（参考 SFC 解析器硬编码的置信度 0.78）解析：每个 `<script>` 块经合成文本抬升到 JS/TS walker——填充换行使抽取记录保持原文件行号，`lang="ts"` 选用 TypeScript grammar，文件同时获得一个横跨全文件的合成 `component` 符号（路径 stem 的 PascalCase 名、默认导出、uid 基于组件身份）。模板层产出：每个大写开头标签一条未解析的 component-usage 引用（跳过组件自身名），以及模板事件调用边（Vue 的 `@evt="h"` / `v-on:evt="h"`，Svelte 的 `on:evt={h}`），dispatch 记为 `event_emitter`，统一携带 `sfc_template` 策略标签。

导入说明符相对工作区根解析（`resolveImport`）：Python 点分模块（`a.b` → `a/b.py` 或 `a/b/__init__.py`）、相对 JS 说明符按 `.ts/.tsx/.js/.jsx/.mjs` 扩展序再 `/index` 文件探测、精确带扩展名匹配；bare 模块与越出根目录的说明符返回 `null`——向上逃逸的 `..` 绝不会折叠成伪造的项目内边。

分块沿用参考语义：每个符号跨度一个 chunk，跨度之间的非空白间隙成为 gap chunk，超预算符号按固定窗口切分（默认 80 行，breadcrumb 保持纯符号名），无符号文件回退纯行窗口。id 由 SHA-256 派生且确定：`uid:` 符号身份基于 `(file, qname, kind, 归一化签名)`，不受行号漂移影响；`sym:`/`call:`/`lit:`/`chunk:` 位置 id 锚定文件/行/列。

## Grammars

`resources/grammars/` 内置 9 个 grammar wasm 文件（10 种语言——`jsx` 共享 JavaScript），来源与逐文件字节数记录在 `resources/grammars/VERSION`。运行时（`Parser.init()`）与每个 grammar 每进程只加载一次并做记忆化；加载失败按语言隔离，不会污染缓存。

## Model Experience

间接地，通过 `search_code_index` 的检索结果体现——其 chunk 元数据（符号、breadcrumb、摘要）由本层抽取。

#### KV Cache effect

对请求前缀无直接影响；抽取记录只决定索引存储的内容，检索答案的缓存键是索引 epoch 对，而非解析内部状态。

## Known Limitations and Deferred Work

- **spec-driven 通道以精度换覆盖**——C#、PHP、Ruby、Swift、Kotlin、Dart、Lua 抽取器没有 AST：符号跨度止于按缩进/`end` 关键字的估算（200 行扫描窗口、30 行兜底），签名与参数类型恒为空，形如声明的调用行（C# 的 `return Helper(x)`）会产生幻影 method 符号，调用边仅按裸名做文件内解析。C# 的 `Environment.GetEnvironmentVariable` 数据流边未移植（本阶段词汇表没有 data-flow 记录）。
- **spec-driven 导入说明符极少可解析**——C#/Kotlin/Scala 点分模块、Swift framework、Dart `package:` URI 与裸的 Ruby/Lua 模块名按设计无法被共享解析器解析；只有携带真实文件扩展名的相对说明符（如 Ruby `require '../util.rb'`）能解析到项目文件。
- **字符串字面量抽取仅覆盖 JS/TS/Python/Rust**——Go、Java、C/C++ 与 spec-driven walker 产出符号、imports 与调用边但不产出字面量行；其字面量抽取随消费它的分类阶段落地。
- **无解析超时 API**——web-tree-sitter 不提供参考实现 `set_timeout_micros` 那样的中断机制；缓解手段是逐文件隔离（一次失败只成为一条 `parseErrors` 记录，不会卡住索引趟），以及对畸形树的容错遍历。
- **单线程 WASM 性能**——解析在调用线程上以逐文件 parser 实例运行；若大型工作区有需要，worker/子进程池仍是备选。
- **字面量按原文入库**——分类（route/url/env-key/… 类别）随字面量索引阶段落地。
- **SFC 通道是正则启发式，不是模板编译器**——`<script>` 块按正则匹配并经 JS/TS grammar 重解析，模板独有语法不产出脚本记录；合成 component 符号横跨全文件（与 script 位置无关），同一源行上的多个 script 块只能在合成文本中错开到相邻行。多块文件的每个块按合成文本当前行数相对填充，使记录保持原文件行号——参考实现从文件头重复填充，后块行号漂移，此处为已记录的偏离。
- **SFC 置信度偏离 heuristic 默认值**——vue 与 svelte 上报参考 SFC 解析器硬编码的 0.78，而其余 heuristic 档语言均为 0.5；该值固定在分层表中，不来自 tier 默认值。
- **SFC dispatch site 未移植**——参考实现的 `VueChildComponent`/`VueEventHandler` dispatch-site 记录与 `synthesized_by`/`synthesis_key`/`registered_*` 来源列不在本包词汇表内；SFC 来源由 `sfc_template` 这个 `resolutionStrategy` 标签承载，两类模板记录出生即为 `unresolved`，留给解析阶段。
- **SFC 模板之外的标识符引用为空**——`symbolRefs` 仅承载 SFC 模板层的 component-usage 引用；通用标识符抽取随解析（resolution）阶段落地，调用位置引用由 `callEdges` 承载。
- **id 与参考实现不跨库兼容**——本包用 SHA-256，参考实现用 blake3；两侧存储互不混用，无需互通。
- **Phase 2 早期构建的库携带过时 id 值**——逐次出现的 id 现在把行/列按小端 u32 字编入哈希，早期 Phase 2 构建派生的 id 不再匹配；此类库请用 `refresh({ forceRebuild: true })` 重建一次。
- **grammar wasm 为只读内置资产**——不在原位重新生成；`resources/grammars/VERSION` 记录每个上游 release 地址与字节数。npm 包 `tree-sitter-wasms@0.1.13` 采用 web-tree-sitter 0.26 无法加载的旧版 `dylink` 段格式，因此内置产物来自各官方 grammar 仓库的 release 构建。
