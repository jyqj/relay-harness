# @relay-harness/rlh-context-inspector

[English](README.md) | 中文

从 durable `context/prepared` 派生的有界全日志 Session Projection。它把每项贡献关联到准确进入模型的 `user/message` seq，保留未采纳/被改写的空链接、证据 provenance、source/path/revision、freshness、verification、truncation、coverage 与 provider why-used 原因。保留最近 50 条 trace 和 500 条消息事实，并显示更早 trace 数。

## Model Experience

### 不直接请求模型

#### 模型看到什么

不直接看到任何内容，也不新增 `user/message`。本包只观察或管理已派生的上下文／索引状态，从不组装模型请求。

#### Token 影响

直接影响为零。只有显式索引或治理操作后，后续上下文检索才可能改变。

#### KV Cache 影响

本包不引入请求前缀或 cache key 变化。

## 已知限制与延后工作

- 有界投影省略 50 条以前的 trace 正文。Provider domain 未携带 `selectionReason`、`reasons` 或 `matchedBy` 时，why-used 回退到 contributor 归因。
