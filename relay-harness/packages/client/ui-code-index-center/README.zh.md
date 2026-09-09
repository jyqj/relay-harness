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

Session 选择通过框架 `useSessions` hook 读取。重建确认归属于打开它的 Session：切换 Session 会关闭确认并清空口令，重新打开也必须再次输入 `REBUILD`。浏览器入口不公开组件和缓存实现。

状态缓存按 Session 分区，仅允许最新准入的请求发布结果。连接重置同时清除缓存和待处理请求的归属，迟到回包不能恢复已失效状态。状态读取会等待本缓存中同一 Session 的维护请求结束，再绕过旧缓存取值。连接重置保留此等待机制，但会撤销缓存发布归属。这不会串行化 Host 操作、其他 Session 或其他客户端，也不会取消已派发请求。

插件卸载会永久停用所属缓存实例，保留的旧回调不能再发起调用。等待中的状态读取在维护结束后重新检查生命周期，因此热重载不会让它们借替代插件继续执行。已经派发的 Host 工作不会被取消。
