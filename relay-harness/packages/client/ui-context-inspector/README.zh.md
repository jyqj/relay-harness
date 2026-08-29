# @relay-harness/rlh-client-ui-context-inspector

[English](README.md) | 中文

基于 `contextInspector` Session Projection 的会话头部 Context Inspector 抽屉。它展示 step 摘要、已采纳和未采纳贡献、关联消息、证据 source/path/revision、freshness、verification、truncation、coverage 缺口与 why-used，无需重写 Chat。

## Model Experience

### 不直接请求模型

#### 模型看到什么

不直接看到任何内容，也不新增 `user/message`。本包只观察或管理已派生的上下文／索引状态，从不组装模型请求。

#### Token 影响

直接影响为零。只有显式索引或治理操作后，后续上下文检索才可能改变。

#### KV Cache 影响

本包不引入请求前缀或 cache key 变化。

## 已知限制与延后工作

- 抽屉遵循投影上限，不额外获取已省略的历史 trace 正文。
