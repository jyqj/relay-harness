# `@relay-harness/rlh-issue-workflow-file`

[English](README.md) | 中文

Markdown／YAML Provider。YAML front matter 承载 Tracker 路由、轮询、并发、重试、continuation 和 stall 策略；Markdown 正文是严格的首轮模板。启动必须读到有效文档。`orchestration.max_continuation_attempts`（默认 5，`0` 关闭上限）限制一个完成后仍可执行的 Issue 被再派发的次数；后续无效或缺失版本会记录错误，并继续使用最后一个有效 snapshot。

## 模型体验

### 仓库 Workflow 提示词

#### 模型看到什么

模型看到经过严格替换受支持 `issue.*` 与 `attempt` 字段后的 Markdown 正文。

#### Token 影响

首个 Issue 轮次随任务大小变化；配置的 continuation 模板有界，仅在仍可执行时重复。

#### KV 缓存影响

一次运行捕获一个版本；编辑文件会改变未来运行，不会改写活动 Session 前缀。

## 已知限制与延期工作

- **小型模板语言** — 仅支持显式标量 placeholder；有意不支持条件和循环。
