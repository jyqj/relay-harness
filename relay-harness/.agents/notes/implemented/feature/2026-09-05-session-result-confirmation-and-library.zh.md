# Agent Note：确认持久化的 Session 结果记录并检索其产物

Status: implemented

[English](2026-09-05-session-result-confirmation-and-library.md) | 中文

## 问题

模型声明 goal 完成不是用户确认，工具成功也不是验证。只看当前页面的产物列表还会遗漏更早和冷 Session 的结果。把追加回执视为持久化，会让失败的 flush 在其他标签页或重挂载后显示成功；按当前选中工作区解析产物则可能打开错误文件。

## 决策

[Host work-results 适配器](../../../../packages/host/work-results/README.md)拥有基于既有 Session 日志的纯产物和确认投影，不创建平行 Work 状态存储。`work/accepted` 记录所审阅的非确认序号和 `actor: 'host-client'`；确认不改变 goal phase、不授予工具权限，也不声明测试成功。既有 Agent maintenance 事务拥有该动作，在 append 前立即重复检查调用方、安静状态、待处理交互和修订值。同修订值重试复用回执，冲突的维护动作会被拒绝。

[Gateway](../../../../packages/api/gateway/src/index.ts)只提供活动的原始可信 Connection 请求，在 `finally` 中使其失效，不为直接调用创建来源。适配器检查确切原始端点，并拒绝 agent initiator。嵌套端点和逃逸回调不能借用已结束请求。所有 Work 端点使用既有 loopback-only 传输策略。这是可信 Host 客户端来源，不是物理人手势的证明或新的身份认证机制。

确认成功要求在 flush 后物理读取已持久化回执。验证读取在等待前捕获切面，并确认对应存储回执和尾部；更晚的内存事件只会使其 `current` 标志变为 false。[Work UI](../../../../packages/client/ui-product-shell/src/client/WorkPage.tsx)绝不把原始投影到达升级为已保存确认。它只在安静审阅时点验证，随事实变化失效，尊重已过期响应，并隔离已取消或迟到请求。流式更新不会逐 chunk 触发验证，也不会发布其他事实未变化的 Work 值。

资料库查询使用有界、非激活式 Session 读取，报告扫描覆盖、不可用历史及旧版未捕获结果。游标身份包括查询、Session 顺序、活动产物投影和冷存储修订值；相关变化会拒绝续页，而不是丢掉已经扫描过的 Session 新增产物。打开产物保持为一次 Host 请求：验证确切的已记录候选项，按来源解析相对路径，在分发前再次观察规范目标，然后调用既有原生 opener。原 opener 拥有权限和拒绝决定。仅限 cwd 的规则不是授权模型：合法外部文件和已引入符号链接仍受支持。

## 考虑过的替代方案

- 让 `goal.complete` 或成功工具标记用户确认：两者都混淆执行声明与外部客户端的显式确认。
- 发布回执后依赖一个组件的本地错误状态：其他标签页或重挂载会读到同一未 flush 事件并错误显示成功。共享 Host 验证改为证明一个具体持久化切面。
- 保留第二个 Work 数据库，或把活动投影复制成客户端权威：两者都可能与重放和 Session 恢复不一致。查询响应是呈现快照，日志和持久化 owner 仍是权威。
- 从 cwd 包含关系推断打开权限：既有显式文件、临时产物和符号链接可能合法地位于该目录之外。记录路径证明来源，原生打开保留原授权归属。

## 影响

[Host 测试](../../../../packages/host/work-results/tests/host.spec.ts)通过 app-boot 和 Loader 启动 `cordis.yml`，调用真实 HTTP Remote 端点，执行 JSONL 恢复和 SDK JSON-RPC 分帧，并检查冲突、持久化失败、嵌套／直接／agent 调用、有界资料库页面、游标失效、来源身份、外部文件及目标变化。[组件测试](../../../../packages/client/ui-product-shell/tests/pages.client.spec.tsx)覆盖显式确认和分页。独立编写的[审阅回归](../../../../packages/client/ui-product-shell/tests/review-regressions.client.spec.tsx)覆盖保存失败后的重挂载及多个视图、过期响应、Session 切换时取消验证、待完成原生打开跨越收起／展开，以及查询变化后的陈旧错误。

确认对象是 Session 日志前缀，而不是文件内容哈希或全部 continuable child 已完成。外部文件编辑不一定追加 Session 事件。恢复记账可能在没有新模型轮次时保守地使旧回执失效。文件路径仍是可变定位符；操作内目标变化检测不是不可变文件身份。相关语料变化时，资料库修订检查可能要求重试。源码和组件证据不能代替构建后浏览器、平台矩阵或真实提供方运行。
