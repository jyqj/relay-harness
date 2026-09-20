# Agent Note：Work 页面内容审核 currency 徽章

Status: implemented

[English](2026-09-20-work-content-review-badge.md) | 中文

## 问题

Host 侧已有 `workResults/contentReview`（最近一次已记录的内容审核及逐版本 currency），远端客户端绑定也已存在，但没有任何客户端界面渲染它：用户看不到某次已记录的内容审核是否仍描述当前文件。唯一可见的验收信号仍是不覆盖文件内容的日志前缀记录确认。

## 决策

Work 页面的审阅卡片在记录确认徽章旁渲染一个只读的内容审核徽章。页面注入 `contentReview(sessionId, signal)` 回调并转发到 `remote.workResults.contentReview`；该读取不激活实例，每个 Session、握手 epoch、可用性切换和显式重新核对只触发一次，并遵循页面现有的中止与代际规则，旧 Session 或旧 epoch 的迟到响应不会进入展示。

展示状态把逐版本 `currency` 列表聚合为最差一项：任一 `changed-unreviewed` 优先，其次任一 `not-reverified`，最后是 `matches-confirmed`。首次审核之前、读取失败或页面未同步时不渲染徽章——缺席本身就是诚实状态。本切片只做展示；提交新的内容审核（`recordContentReview`）没有界面，留作后续。Host 读取不附带新鲜文件观察，因此当前实际读取会把每个已确认版本报告为 `not-reverified`；聚合仍然处理全部三种状态，因为调用方侧或未来 Host 侧的新鲜观察都经过同一读取契约流入。

## 已考虑的替代方案

**每个已确认版本单独一行。** 本切片不采纳：审阅卡片保持紧凑，且逐版本身份在提交界面出现后才有意义；最差状态聚合足以回答"已确认的审核还能不能信"。

**中性的"尚无内容审核"提示行。** 不采纳：确认徽章已经表达日志记录的"未确认"，第二条空闲态提示会让人把内容审核缺席误读为记录确认事实。

**在客户端用本地文件观察套用 `contentCurrency`。** 不采纳：浏览器没有权威的文件观察，用工具调用历史伪造 currency 状态会重演内容审核领域要避免的记录确认过度声明。

## 后果

用户在记录确认徽章旁看到三种双语 currency 标签之一；没有审核、读取失败或页面未同步时什么都不显示。徽章是被动的：不阻塞确认操作，也不引入轮询。未来的提交界面可以复用同一个注入读取，在 `recordContentReview` 成功后刷新徽章。

## 验证

`packages/client/ui-product-shell/tests/content-review.client.spec.tsx` 固定了每种 currency 输入的最差状态聚合、首次审核之前或读取失败时不显示徽章、以及旧握手响应被中止且不会污染当前徽章。`packages/client/ui-product-shell/tests/apply.client.spec.ts` 验证注入回调按精确的请求与信号转发到 `remote.workResults.contentReview`，包括拒绝信封路径。`node_modules/.bin/tsc -b packages/client/ui-product-shell` 通过。
