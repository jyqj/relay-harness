# @relay-harness/rlh-client-ui-code-index-center

[English](README.md) | 中文

Web Settings Code Index Center 展示文件/chunk 健康、epoch、Embedding generation、向量覆盖、积压、失败、BuildExplain 与紧凑 debug 命中。刷新和 reconcile 可直接执行；破坏性重建要求输入 `REBUILD`，Host 还会独立校验 token。

## Model Experience

### 不直接请求模型

#### 模型看到什么

不直接看到任何内容，也不新增 `user/message`。本包只观察或管理已派生的上下文／索引状态，从不组装模型请求。

#### Token 影响

直接影响为零。只有显式索引或治理操作后，后续上下文检索才可能改变。

#### KV Cache 影响

本包不引入请求前缀或 cache key 变化。

## 已知限制与延后工作

- 空白/无目录 Session 没有索引目标；UI 会要求选择 Workspace，不会回退到其他缓存条目。

- 检索调试有意只返回紧凑候选元数据，绝不 hydrate 源码正文。
