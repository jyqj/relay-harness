# Agent Note: 将 code-index 候选与已验证源文件 hydration 分离

Status: implemented

[English](2026-08-29-code-index-candidate-hydration.md) | 中文

## Problem

code-index 搜索引擎已经读取 chunk 正文来打分，但公开 `SearchHit` 只投影路径与行号，`code-context` 却把这份元数据渲染成可用代码 evidence。把 evidence 绑定到全局 `indexEpoch` 无法识别具体源文件 revision，watcher 延迟还会让索引正文落后于当前文件。若直接把完整源码放进每个 `SearchHit`，则所有消费者的工具输出与 graph cache 都会膨胀，包括从不接纳源码的消费者。

## Decision

code-index seam 将候选发现与 hydration 分离。`search()` 返回紧凑候选，携带已索引文件的 `contentHash`、语言、真实 parser tier/confidence、顺序固定的加法 `scoreTrace` 与 reason token。provider-neutral request 暴露 working-set、pinned、overlay 和有序 conversation-query 信号；最新四条不重复 conversation query 影响 lexical/preselect/overlap，grep 仍只使用 primary query。

`hydrateChunks()` 按请求中首次出现的顺序批量解析完整存储正文。local provider 把存储路径约束在工作区内，对每个不同的当前普通文件执行哈希，并且只在哈希匹配已索引 revision 时返回正文。缺失行、非法或不可读路径、revision 漂移分别成为显式 `unavailable` 或 `stale` rejection。该操作保持在 search result 与 graph cache 之外。

[语言与 code-context note](../feature/2026-08-28-code-index-heuristic-languages-and-context-contributor.md)描述的 opt-in contributor 执行一次 search、一次有界候选 batch hydration，比较 search 与 hydration 的内容哈希，并且只注入已验证源文件的 fenced snippet。Evidence revision 是文件内容哈希，digest 覆盖实际接纳的源码子串，机械验证为 `verified`；被拒绝的 hydration 会进入 warning 与 coverage，绝不渲染成 path-only fallback。

## Alternatives considered

- **在每个 `SearchHit` 内联完整正文**——否决：源码字节会占用 search result 预算、扩大 graph-cache 条目，并向只需要 location 的工具消费者收费。
- **由 `code-context` 直接读取文件**——否决：consumer 会重复工作区 containment、chunk identity、parser 来源、revision 比较以及 provider-specific 存储知识。
- **在 `indexEpoch` 下信任索引正文**——否决：全局 generation 既不能识别单个资源 revision，也不能发现 backing file 在 watcher 刷新完成前已发生变化。
- **只用 mtime 与 size 接纳 evidence**——否决：被选中的候选 batch 足够小，可以执行哈希；把 evidence 标为 current/verified 之前必须取得精确内容 revision。

## Consequences

搜索候选保持为有界元数据，cache 不含源码；上下文消费者只为实际选择的 chunk 支付文件哈希成本。hydration 可能返回比 search 更少的正文，consumer 必须保留 index miss、stale source 与 unavailable source 的区别。文件哈希沿用 provider 既有的截断 SHA-256 内容 identity 契约，因此变更 identity 方案属于 seam-level revision 决策。完整 Context Trace 持久化与 UI 投影不在本决策内。
