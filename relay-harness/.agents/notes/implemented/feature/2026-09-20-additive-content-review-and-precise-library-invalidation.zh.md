# Agent Note: 加性内容审核与精确的 Library 失效

Status: implemented

[English](2026-09-20-additive-content-review-and-precise-library-invalidation.md) | 中文

## Problem

按照既有明确决策，review 绑定 Session 日志前缀，用户因此无法记录自己实际检查过的内容：读了哪些文件字节、对它们运行过哪些检查。另外，Library 在每个 `tool/result` 上都使全部保留查询失效，一个长时间运行的会话就会反复触发全语料重新观察。

## Decision

把内容审核加在日志前缀确认旁边，而不是叠在它之上。`work/reviewed` 是新的仅日志事件，携带绑定到显式 `WorkContentVersion` 身份和 `WorkCheckRecord` 事实的用户决定，所有引用都在其所属事件内解析。它不命名前缀，复用回执持久化模式（可信请求、maintenance 串行、flush 加物理重读、相同重复提交复用），并且完全不触碰 `work/accepted`、`workAcceptance` 与确认策略。读取侧把已确认与当前分开：`workResults/contentReview` 对每个已确认摘要报告 `not-reverified` currency，只有来自真实新鲜观察的纯比较才会把它升级为 `matches-confirmed` 或 `changed-unreviewed`。没有文件监听，也没有重验承诺。

Library 失效收窄到保留观察再也无法诚实服务的情形：会话创建或销毁、来自查询已观察语料之外会话的 `tool/result`，或会实际改变已观察清单的 `tool/result`（新路径或未捕获的成功）。错误结果与已知路径不会使仍然有效的分页失效。缺口照常报告，统计仍按来源身份去重。

## Alternatives considered

**复用 `work/accepted` 并附加可选载荷。** 单一事件会诱使客户端把前缀确认与内容声明混在一起，削弱既有回执不变量；独立事件保住了按设计的会话日志语义。

**读取时由 Host 重新哈希。** 让 `contentReview` 读取设备文件会把被动读取变成验证行为，并承诺 Host 在请求之间无法保证的新鲜度；比较保持为纯函数，由调用方对已持有的观察应用。

**按查询失效而非清空全部查询。** 各查询共享 epoch 守卫与淘汰池；只失效被触碰的查询会让同一变化语料的过期分页经由其他查询继续可达，而在既有上限内（至多 `maxLibraryQueries` 个观察）没有任何可测量的节省。

## Consequences

`work/reviewed` 进入已知事件词表，因此本构建写出的日志在早于它的构建中拒绝加载（符合仓库发布前的既定立场）。内容审核与其他事实一样让日志增长，并且已批准的摘要在有人重读之前不证明当前文件的任何事。Library 分页现在能在嘈杂会话下存活，但被完整语料观察省略的会话（超过 `maxLibrarySessions`）在其首个结果上仍会触发失效——精确规则在省略边界上仍然是保守的。`docs/subsystems/work-results` 的生成 cordis-surface 块未在此处重新生成：目录生成器无法对本 worktree 的过期构建面运行，且当前因既有未分类类型而失败；该再生成由合并轮负责。

## Verification

包测试覆盖经可信 HTTP 端点的持久化、无激活的冷读取、引用解析拒绝、字节级相同重复提交复用、已确认与当前的 currency 状态，以及不变量的未解析引用检查；Library 测试保持错误结果分页有效、在新贡献结果上失效，并保留缺口报告。`tsc -b` 对被改包通过。再生成的持久化目录与重新记录的双语摘要包含在本变更中。
