# Agent Note：在工具主体准入和串行写入时重新检查所有权

Status: implemented

[English](2026-09-05-final-dispatch-and-queued-write-fencing.md) | 中文

## 问题

异步等待前成功的所有权检查不能授权等待后的工作。工具 guard 在环绕分发和资源获取之前运行，因此已过期的 Activation 租约可能通过准备阶段，并在续租计时器发出取消前进入工具主体。持久化延迟写入在加入按 id 串行队列之前检查 Session fence；并发读取可能把 append 延迟到所有权变更之后。初始化读取也可能在所有权失效后才完成，随后修复已存储的尾部。

## 决策

[工具注册表](../../../../packages/core/tools/src/index.ts)在准备后检查活动的单调 guard，并在持有全部资源锁时、每次调用工具主体之前再次检查。最终拒绝使用与准备阶段拒绝相同的规范化错误结果，不会把工具主体标记为已启动。guard 支持重复的同步检查，包括重试包装层发起的调用。准备阶段之后可见的作用域 guard 替换会参与最终准入。

[持久化协调器](../../../../packages/session/session-persistence/src/coordinator.ts)在缓冲 Session 的操作离开按 id 串行队列后重新检查其 fence。公共 append 实现在调用后端前检查确切的活动 owner，同时覆盖直接服务 append 和缓冲写入。初始化在异步读取后，以及绑定 owner 或修复存储尾部之前重新验证所有权。活动控制器通过 `captureSessionPersistenceFence()` 捕获确切的证明，并在批处理、重试和退休期间保留它，因此退休 Session fence 不会使延后的检查变成空操作。退休也会关闭该 Session 对象的源日志 append 准入；其终身证明不可替换，后继 owner 使用新的 Session。检查失败时，尚未启动的变更不会写入，缓冲事件在重试时仍受相同检查约束。

冷 setup 失败后，不能把已安装终身 fence 的 Session 放回 prepared-source 缓存。事件数量相同不足以证明可复用：安装 proof 不追加事件，而 rollback 会永久退休该 proof。释放此类 preparation 时丢弃其对象图；下一个所有者重新加载新 Session，不删除或替换旧 proof。未加 fence 且未变更的 preparation 保持原有复用行为。

## 考虑过的替代方案

- 依赖续租取消：事件循环暂停可能使租约先于取消计时器执行而过期；最终操作必须自行检查所有权。
- 仅在入队前检查：无关的串行读取可能把存储分发延迟到 owner 有效期之外。
- 仅凭断言宣称原子的跨进程 fencing：分发前检查无法排除异步后端 I/O 期间的接管。独立的[提交排他决策](2026-09-05-persistence-commit-takeover-exclusion.md)为 Activation 所有的持久化提供共享变更锁。

## 影响

[作用域工具测试](../../../../packages/core/tools/tests/scoped.spec.ts)覆盖环绕分发期间撤销准入和活动 guard 替换。[资源锁测试](../../../../packages/core/tools/tests/resource-lock.spec.ts)覆盖等待期间撤销，以及拒绝后释放已取得的资源。[持久化测试](../../../../packages/session/session-persistence/tests/persistence.spec.ts)覆盖排队的活动会话 flush、向活动 id 直接 append，初始化期间失去所有权后的撕裂尾部修复，以及fence 退休后的排队或退休写入，以及源日志封口和拒绝替换 Session 终身证明。这些确定性测试断言所有权检查失败后不会启动工具主体或存储变更；它们不保证外部副作用恰好执行一次，也不保证回滚已经启动的操作。普通成功 transcript 内容不变；现有可运行应用快照继续提供正常路径证据。

独立接管回归使用真实 JSONL 与 SQLite 提供方：继任进程先提交自己的轮次，再恢复旧所有者的排队写入，持久读取只保留继任历史。两个后端还验证失败的 fenced preparation 使用新 Session 身份重试，并在继任租约下成功提交。
