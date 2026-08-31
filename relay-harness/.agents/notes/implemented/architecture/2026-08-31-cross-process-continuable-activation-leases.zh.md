# Agent Note: Cross-process continuable Activation leases

Status: implemented

[English](2026-08-31-cross-process-continuable-activation-leases.md) | 中文

## Problem

持久 child Session 与 mailbox 可以跨重启恢复，但 Activation ownership 仍只是一张进程内 map。共享持久化的两个 Harness 进程可能同时冷恢复同一 child、执行轮次并追加相互竞争的历史。崩溃后也没有有界接管点。Session persistence 有意拥有 append-only 日志而非 live execution lease，因此在其中添加一个不带 fence 的布尔值无法解决陈旧 owner 清理。

## Decision

`SubagentActivationLeaseStore` 是由 `SubagentRuntime.activationLeasePath` 选择的专用 SQLite Adapter。随发行版提供的 base 使用 `$RLH_HOME/subagent-activation-leases.sqlite3`；直接 composition 可以省略它，以保留显式单进程兼容。每个 child 行携带随机 owner token、单调递增整数 fence 与 epoch-millisecond expiry。`BEGIN IMMEDIATE` 会串行化获取：尚未过期的外部行以 `ACTIVATION_LEASE_HELD` 失败；不存在、已释放或已过期的行会推进 fence 并成为新 owner。续约、当前 owner 检查与释放都会比较 child id、token 和 fence，因此陈旧 handle 无法续约或移除后继 owner。

管理器会在创建 Agent 前获取 lease，并在异步 setup 执行期间运行 acquisition-phase 续约。setup commit 会在 registry publication 之前立即检查确切 token／fence；创建后的检查覆盖剩余 return edge。因此，setup 期间被接管的缓慢陈旧 creator 会 dispose 尚未发布的 handle，并以 `ACTIVATION_LEASE_LOST` 失败。驻留 Activation 会定期续约，在 pre-step 及每次 follow-up、report 或 interrupt 准入时断言 ownership；续约失败会取消并 dispose Agent。dispose 会停止续约，并只释放确切 fence。

child 会把同一 owner／fence 安装为 `SessionPersistenceFence`。`Session.append()` 会在改变内存源日志前拒绝陈旧 owner，第一方持久化协调器还会在入队、flush、初始化完成和串行化后端 append 前复查。child 同时注册单调 tool guard，在授权结束后、工具主体执行前立即检查。授权期间丢失 lease 会拒绝副作用；活跃调用期间丢失 lease 会取消 Agent，而外部系统无法证明是否提交时继续使用既有 outcome-unknown 记录。

默认 lifetime 为 30 秒，renewal 为 10 秒。时间配置和 `now + leaseMs` 都必须保持为正 safe integer。崩溃进程会原样留下该行；只有明确过期后才允许接管。

## Alternatives considered

**复用 `withFileLock`。** 未采用，因为它刻意规定绝不移除未知 owner 的陈旧 lock，因此无法提供定时崩溃接管。

**把 lease 放进每个 Session backend。** 未采用，因为 JSONL 与 SQLite 的拓扑不同，可选 backend 方法会把一条 ownership 规则拆散到每份实现。专用数据库让每种持久化 backend 共享同一套原子 CAS 语义。

**按年龄删除 lock 文件。** 未采用，因为文件年龄无法区分崩溃进程与暂停 owner；unlink 还会让陈旧 owner 之后移除后继 owner。

**宣称可以回滚已经提交的外部 effect。** 未采用。owner fence 现在覆盖 Activation publication、管理器准入、Session append/write 准入和工具主体准入，续租丢失也会取消活跃调用。但本地机制无法逆转在观察到 abort 前已经提交的远端系统；outcome-unknown 恢复与领域 reconciliation 在该处仍是权威机制。

## Testing

Store 测试覆盖两个 owner、续约、未过期拒绝、过期接管、单调 fence、陈旧续约／释放拒绝、带未释放崩溃行的重启，以及 safe-integer overflow。集成测试证明第二个 runtime 无法物化已被 lease 的 child；setup 期间被接管的缓慢 creator 会在 publication 前 commit 处失败且不留下 live Agent；`tools/pre-execute` 期间发生接管会拒绝工具主体；陈旧 Session append／flush 也不会进入持久后端。

## Consequences

配置 `activationLeasePath` 后，两个有效 Harness owner 无法并发发布同一可继续 child；崩溃 owner 可在可见超时后被替换。健康 owner 会在获取／续约／准入检查时支付同步 SQLite CAS 成本。省略 Adapter 的嵌入部署保持源码兼容，但仍受已记录的单进程限制。该 fence 现在覆盖本地控制、工具启动、Session append 与持久写入 plane；外部系统仍是独立事务，必须遵循其普通 reconciliation 约定。
