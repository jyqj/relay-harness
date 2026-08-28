# @relay-harness/rlh-tool-code-index

[English](README.md) | 中文

**本地代码索引能力（`ctx.codeIndex`）的模型可见消费者**：`search_code_index` 对索引切片做带理由的排序检索，`explore_code_graph` 回答派生调用图上的结构化问题，`code_index_status` 报告索引健康状态，`refresh_code_index` 将派生索引更新到最新（或强制重建）。本包负责 schema、参数校验、出口侧输出预算、prompt 指引与 UI 呈现；存储、扫描、排序与并发折叠语义全部留在提供 `ctx.codeIndex` 的 provider 侧。

Function 插件形态（`name` / `inject` / `Config` / `apply`，无 default export）。注入 `tools` 与 `systemPrompt`；seam 刻意不进 `inject` —— 每次 execute 通过 `ctx.get('codeIndex')` 解析，因此未安装索引 provider 的组合可以正常加载，单个调用会以结构化错误 `INDEX_TOOL_UNAVAILABLE` 失败。

```ts ignore-check
// The provider supplies ctx.codeIndex; this Consumer rides on top of it.
await ctx.plugin(LocalCodeIndexProvider)                    // the provider package for your backend
await ctx.plugin(ToolCodeIndex, { clampTopKToTier: false }) // @relay-harness/rlh-tool-code-index
```

出口侧字节上限移植自参考实现的 `ExitPolicy` 设计：它是单一边界上的保护层，而非正确性层。引擎排序与分档钳制仍是真实的界；执行完成后才从答案自身携带的仓库规模档位读取预算，与参考实现的缓存档位语义一致。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `clampTopKToTier` | `false` | 为 true 时，`search_code_index` 的 schema 中移除模型可用的 `top_k`，显式传值也会被丢弃，命中数完全由引擎按仓库规模档位决定。 |

## 工具

| 工具 | 参数 | 行为 |
|---|---|---|
| `search_code_index` | `query`、`path_prefix?`、`top_k?`、`paths?`、`recent_paths?`、`include_grep?` | 对已索引切片做排序检索。参数映射到 seam 的 camelCase 请求字段（`pathPrefix`、`recentPaths`、`topK`）；`include_grep: false` 作为 grep 通道的提示性字段转发，provider 可忽略。同一 epoch 内结果确定，并用 `reasons` token 自解释。 |
| `explore_code_graph` | `op`、`symbol?`、`file_path?`、`direction?`、`depth?`、`files?`、`include_tests?`、`max?` | 派生调用图上的结构化图问题：`op=relations` 沿某符号的 caller 和/或 callee 行走（深度 1–2，`file_path` 可在重名时钉住声明文件）；`op=impact` 对符号或文件集做反向可达性扫描并附受影响测试（`include_tests: false` 关闭）；`op=tests` 将代码文件映射到覆盖它们的测试；`op=cycles` 报告文件导入环组件并按规模从大到小排列（`max` 在降序排列之后截断，因此保留的总是最大的环）；`op=dead_code` 列出无调用方且无外部引用的符号（`max` 封顶输出；候选扫描运行 `min(40 × max, 5000)` 的有界超集）。跨 op 的非法组合（relations 带 `files`、tests 带 `direction`、`files` 为空列表等）属普通参数错误；符号解析不到时返回空答案，并在 `explain.readErrors` 记一条 `symbol_not_found: <name>`。
| `code_index_status` | 无 | 零参健康报告：已索引文件数、档位、当前 epoch、最近一次刷新摘要、降级标志。天然有界。 |
| `refresh_code_index` | `force?` | 对工作区树做增量刷新；`force: true` 从头重建。并发调用在 seam 内折叠为一次提交。 |

渲染天然紧凑：每个 hit 一行 `path:start-end score reasons`；explore 答案输出档位标注的 op 表头、每 node 一行（`role kind name @ file:start`）、每边一行（`caller: X → Y (f:line)`，即 enrich 模板）、每测试对一行（`test: spec → code (reason)`）、每环组件一行（`size n: a → b → c`）、每 dead-code 候选一行（`dead: kind name @ file (reason)`）、`explain: declared=[...] candidates=N` 摘要，以及仅在截断发生时出现的 `(truncated: <reason>; N candidates considered)` 尾标；status 输出确定的 `key: value` 行，refresh 输出以提交后 `indexEpoch` 收尾的带标签摘要。当序列化 JSON 超过所在档位的字节数预算（`repoSizeTierMaxOutputChars`：18000/24000/32000/38000 字节）时，规范值变为截断信封 `{ _truncated, _original_chars, _max_chars, partial }`，渲染为恢复指引文案，绝不把 partial 内容重新展开进上下文。

## 错误

失败在 `isError` 结果上携带 `{ name, code }` 元数据：`INDEX_TOOL_UNAVAILABLE`（未加载 `ctx.codeIndex`）、`INDEX_TOOL_REFRESH_IN_PROGRESS`（上一次工具发起的刷新仍在等待中——立即给出结构化反馈，而不是排队等待重复的第二次摘要）、`INDEX_TOOL_FAILED`（provider 抛出了没有稳定 `HarnessError` code 的异常；原始错误挂在其 `cause` 上）。稳定的 provider 词表（如 `CODE_INDEX_NOT_INDEXED`) 原样透传，调用方按 seam 定义的同名 code 路由。模型参数错误（空 `query`、非正数 `top_k`、`explore_code_graph` 的跨 op 非法组合）仍属普通工具参数错误。

## 模型体验

### 系统提示词

#### 模型看到什么

一个固定 section（名称 `tool:code-index`，order 107，位于文件发现类与 shell 类工具之间），说明何时用索引替代裸扫描：

##### 逐字文本

```markdown
Prefer search_code_index over grep/glob when locating the symbols, declarations, or chunks relevant to a change question: it ranks indexed spans with explanations and costs far less than raw scanning. Once you know the symbols involved, use explore_code_graph for cross-file structure questions: it walks callers and callees of a symbol, sweeps what a change would break together with its impacted tests, maps files to the tests that cover them, and surfaces circular import cycles and never-called symbols. Use grep/glob instead for exact literals and formats the index may not cover, or when you need every occurrence. If results look stale after edits, check code_index_status for the current epoch and call refresh_code_index (force only to rebuild from scratch) before blaming the index for a miss.
```

#### Token 效果

插件作用域激活期间每次请求固定开销；agent 级工具限制隐藏任一 schema 时该 section 不随之移除。

#### KV Cache 效应

section 文本与位置不变时前缀稳定；卸载或未来措辞变更会使从首个变化 token 开始的复用失效。

### search_code_index

#### 模型看到什么

生成的 [`search_code_index` schema](../../../docs/tool-catalog.md#relay-harnessrlh-tool-code-index)，随后要么是档位标注表头下的紧凑命中行（`path:start-end score reasons`），要么在 `readErrors` 非空时附带 `[degraded]` 说明，要么仅在引擎发生排名截断时出现候选计数脚注；超出档位字节预算时则呈现描述截断信封的恢复文案，而不是内容本身。

#### Token 效果

双重有界：引擎 top-K 控制命中数量，出口字节上限约束完整序列化答案；常规答案远低于该上限，错误只增加一条短消息。

#### KV Cache 效应

追加式；工具结果位于可复用请求前缀之后，不使既有条目失效。

### explore_code_graph

#### 模型看到什么

生成的 [`explore_code_graph` schema](../../../docs/tool-catalog.md#relay-harnessrlh-tool-code-index)；执行返回完整的 `GraphExploreResult` —— nodes、edges、可选 test pairs、携带 witness 边的环组件、dead-code 候选，以及绑定读取答案时 epoch 对的 explain 信封 —— 并按前述紧凑 node/edge/test/cycle/dead 行渲染；超出档位字节预算时呈现恢复文案。

#### Token 效果

双重有界：请求的 `max`（以及分档的每 seed 富化窗口、测试对上限与分析 op 自身的上限）在源头控制答案规模，出口字节上限约束完整序列化答案。

#### KV Cache 效应

追加式；工具结果位于可复用请求前缀之后，不使既有条目失效。

### code_index_status

#### 模型看到什么

生成的 [`code_index_status` schema](../../../docs/tool-catalog.md#relay-harnessrlh-tool-code-index)；执行返回确定的 `key: value` 行（含 `indexEpoch`），已有刷新提交时附最后刷新摘要。

#### Token 效果

每次调用一个小型固定形状报告；形状本身就是自然界限，出口不再设限。

#### KV Cache 效应

追加式；新增内容位于可复用前缀之后。

### refresh_code_index

#### 模型看到什么

生成的 [`refresh_code_index` schema](../../../docs/tool-catalog.md#relay-harnessrlh-tool-code-index)；成功渲染以 `indexEpoch now: N` 收尾的摘要，下一次 `code_index_status` 能看到同一已提交时钟的新值。并发场景立即以 `INDEX_TOOL_REFRESH_IN_PROGRESS` 应答，而不是承诺稍后给出重复的二次摘要。

#### Token 效果

每次完成的 pass 一条小型固定形状摘要；繁忙调用只有一行短错误。

#### KV Cache 效应

追加式；新增内容位于可复用前缀之后。

## 已知限制与延期工作

- **`include_grep` 目前是提示性字段** —— 该字段先于 seam `SearchRequest` 类型扩展挂到出站请求上；旧版 provider 会忽略它并视同为 true。
- **字节上限度量的是 UTF-8 字节** —— 档位常量名叫 `maxOutputChars` 是逐字移植参考实现的结果；多字节内容会比按字符计数更早触顶。
- **刷新忙碌守卫是进程内的** —— 同一 Cordis 树中若存在两个本 Consumer 实例，各自只守卫自己发起的 pass；部署约定本包只挂载一次。
