# @relay-harness/rlh-host-code-index-center

[English](README.md) | 中文

提供有界 Code Index 管理状态、增量刷新、Embedding reconciliation、确认门控的破坏性重建和紧凑检索诊断的 typed Host Remote。Host 对查询长度、路径数和 top-K 设界。

## Model Experience

### 不直接请求模型

#### 模型看到什么

不直接看到任何内容，也不新增 `user/message`。本包只观察或管理已派生的上下文／索引状态，从不组装模型请求。

#### Token 影响

直接影响为零。只有显式索引或治理操作后，后续上下文检索才可能改变。

#### KV Cache 影响

本包不引入请求前缀或 cache key 变化。

## 已知限制与延后工作

- 没有 workspace cwd 的 Session 刻意不可用；Center 不会回退到进程 cwd 或其他 Session。
