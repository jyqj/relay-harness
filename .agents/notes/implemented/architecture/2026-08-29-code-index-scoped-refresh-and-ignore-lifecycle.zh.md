# Agent Note：在本地代码索引刷新链中保留文件系统变更范围

状态：已实现

[English](2026-08-29-code-index-scoped-refresh-and-ignore-lifecycle.md) | 中文

## 问题

公开的 `RefreshOptions.paths` 声称可限制一次 pass，但运行时会丢弃它，每次 stale 刷新仍遍历并 diff 整个工作区。递归 watcher 也在防抖前丢弃原生文件名。此外，scanner 在 provider 生命周期内只加载一次根 `.gitignore`，因此嵌套 ignore 规则和根规则修改都不可见。这些是生命周期正确性缺口而非排序缺口：seam 承诺了实际上没有执行的范围，生成目录可能污染索引，watcher 事件跨过 provider 边界后反而丢失了源头已有的信息。

源码验证式 hydration 还有一个相关的包含边界缺口。词法 `resolve`/`relative` 检查可以拒绝 `..`，但父目录被 symlink 替换后，当前 backing path 可能在哈希前逃出工作区。

## 决策

`RefreshOptions.paths` 在运行时边界规范为唯一的工作区相对 POSIX 路径。逃出工作区会大声失败，根路径有意扩宽为全量 pass，空列表则是真正的零文件范围。scanner 剪枝不可能包含请求文件或前缀的目录；indexer 只 diff 和删除已提交 generation 中匹配的切片。目录范围覆盖全部后代，因此目录删除事件能移除其索引子树而不触碰无关行。

递归 watcher 保留文件名，在防抖窗口内去重并取并集，再经 `StaleInvalidator` 把范围送入 stale refresh。无法命名路径的事件扩宽为全量 pass。工具结果事件没有可信的 touched-path 契约，因此仍作为权威全量失效。`.gitignore` 事件也扩宽为全量 pass，因为一次规则修改可能影响任意后代。

scanner 在每次 pass 中拥有 ignore 发现。硬排除/配置排除保持互相独立的静态层；根目录和嵌套 `.gitignore` 构成一个有序层级，由最深的匹配规则胜出，包括子文档用否定规则覆盖祖先的文件规则。被忽略的目录会在读取其内部文档前剪枝，这与 Git 无法重新纳入被排除父目录下文件的语义一致。

Hydration 现在通过 `realpath` 同时解析工作区根和候选源文件，证明规范路径包含关系，并对规范后的当前文件执行哈希。因此父目录 symlink 逃逸即使指向一个哈希相同的外部文件，也会返回 `source-path-invalid`。

## 考虑过的替代方案

- **保留全量扫描并删除 `RefreshOptions.paths`**——否决；watcher 已提供可用范围，参考构建生命周期也证明事件定域 admission 可行。
- **只信任 watcher 路径**——否决；事件可能省略文件名，工具 effect 也没有路径契约，两者都必须能扩宽为全量 diff。
- **把嵌套 ignore 文件作为独立布尔排除层加载**——否决；并集无法表达更深层 `!` 规则覆盖祖先文件规则。
- **Hydration 只用词法包含判断**——否决；它无法约束 symlink 路径组件。

## 后果

原生文件事件风暴可避开无关遍历、哈希、解析与删除工作。全量 manual/lazy/tool-result pass 仍然存在且保持权威。ignore 文件不会给每个目录增加盲读：walker 仅在目录列表确实包含 `.gitignore` 时读取。选中的变更文件现以确定性有界并发读取/解析；扫描开始后才到达的刷新范围合并为一个后续 generation。不安全配置事件仍需要全量遍历。BuildExplain、Embedding generation/批处理/时钟、独立 vector recall 与可执行 Recall/MRR/p95 门禁已由后续代码索引 note 实现。
