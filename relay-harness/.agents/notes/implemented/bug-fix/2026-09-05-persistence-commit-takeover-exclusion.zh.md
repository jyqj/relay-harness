# Agent Note：在完整持久化提交期间排除租约接管

Status: implemented

[English](2026-09-05-persistence-commit-takeover-exclusion.md) | 中文

## 问题

调用存储后端之前检查 fence，并不能把租约接管与后端的异步 open、write 或 fsync 串行化。租约行和会话数据位于不同存储中。旧 owner 可能在仍有效时进入存储，在 I/O 期间过期，并在后继 owner 获取租约后完成写入。冷恢复还会在活动 setup 安装 Session fence 之前修复历史，因此只保护活动 append 会让恢复留在排他协议之外。

## 决策

[Activation 租约 store](../../../../packages/subagent/subagent/src/activation-lease.ts)为每次所有权获取、释放及完整持久化变更取得 child 专属的 SQLite `BEGIN IMMEDIATE` 锁。变更锁使用独立连接和文件，存储在规范化租约数据库路径之下，并以 child id 的哈希作为文件名。已有锁目录和文件通过 `lstat` 检查；符号链接、悬空链接、非普通文件及多重硬链接锁文件会在 SQLite 打开它们之前被拒绝。锁保持到完整异步变更结束。主租约数据库保留短暂的 token/fence 事务和独立续租；它不会跨后端 await 持有未结束的事务。同 child 的重入准入和外部争用以 `LEASE_HELD` 拒绝，不会同步等待必须先完成当前变更的事件循环。不同 child 保留独立变更锁。

`SessionPersistenceFence.runExclusive()` 通过[共享持久化变更辅助函数](../../../../packages/session/session-persistence/src/mutation.ts)传递这份排他权限。协调器为排队写入和退休过程保留确切证明，在取得锁后重新检查所有权，并等待后端 append 或 repair 完整结束后再释放锁。owner 有效时获准的变更可以在过期后完成，但后继 owner 必须等该提交结束后才能获取租约。旧 owner 的后续变更会被拒绝。外部工具主体只使用最终准入 guard；它们已经启动的外部副作用不会被存储锁回滚或串行化。

`ResumeAgentOptions.persistenceFence` 将同一证明经过 [agent 工厂](../../../../packages/core/agent-loop/src/index.ts)传入 `SessionPersistence.prepare(id, signal?, fence?)`。冷提交及其修订值检查在 setup 之前、在该证明保护下运行。准备过程不安装第二份 Session 注册：continuation 管理器在未发布的活动 setup 中只安装一次同一证明。调用方被取消时，不能在已启动的后端变更仍运行期间释放存储锁。

租约时钟和时长在变更前完成校验。续租与获取一样拒绝零或负时长；被拒绝的续租不能使现有所有者过期。故障注入回归会在创建期间替换锁目录，并拒绝锁文件打开或权限修改，随后证明正常重试仍能取得第一个 fence。

## 考虑过的替代方案

- 跨后端 I/O 持有主租约数据库事务：续租和同进程获取可能重入，或者在原变更仍需要事件循环才能完成时阻塞该循环。独立 child 锁避免了这种耦合。
- 共享一把全局变更锁：无关 child 会因彼此的持久化延迟而被拒绝或等待。每 child 锁保留独立进展能力。
- 使用按超时判旧的锁文件：删除被判断为过期的锁，可能在原进程暂停时准入第二个 owner。SQLite 连接锁在进程死亡时由操作系统释放，绝不通过 unlink 活动 inode 回收。
- 仅保留分发前断言：它们保护排队工作，但不能让完整后端提交与接管串行化。

## 影响

[租约测试](../../../../packages/subagent/subagent/tests/activation-lease.spec.ts)覆盖变更期间续租、过期后继续排他、失败、嵌套准入、陈旧所有权及 store 关闭。[跨进程测试](../../../../packages/subagent/subagent/tests/persistence-takeover.spec.ts)使用真实 JSONL 和 SQLite 提交以及独立 Node owner：I/O 暂停时接管被拒绝，持久化提交后接管成功，持锁进程被终止后接管也成功。[持久化测试](../../../../packages/session/session-persistence/tests/persistence.spec.ts)固定冷恢复处于所传证明之内；[恢复测试](../../../../packages/core/agent-loop/tests/resume.spec.ts)固定 setup 前转发确切证明。

锁文件是持久的协调身份，数量与持久 child id 而非活动 writer 数量同阶。运行时在操作结束后关闭句柄，但绝不 unlink 锁文件。保留策略只能在所有可能打开这些身份的 host 都停止后删除它们；删除活动路径名可能把同一把锁分裂为两个 inode。关闭租约 store 会拒绝新准入，并延后最终句柄关闭，直到现有变更结束。挂起但仍存活的后端会刻意继续排除接管；放弃其 promise 会破坏存储保证。没有支持排他性的证明的部署仍只有分发前检查。绕过共享证明协议的 writer 不在此排他保证范围内。
