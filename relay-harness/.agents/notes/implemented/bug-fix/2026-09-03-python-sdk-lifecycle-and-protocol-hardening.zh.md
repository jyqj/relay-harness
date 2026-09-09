# Agent Note: Python SDK 生命周期与协议校验收紧

Status: implemented

[English](2026-09-03-python-sdk-lifecycle-and-protocol-hardening.md) | 中文

## Problem

Python SDK 有四个静默面，而 TypeScript 孪生侧已一一收紧，两侧行为漂移：

1. `HarnessClient.start()` 的进程检查与 `Popen` 都在锁外，两个线程同时 `start()`（例如并发的 `RelayHarness.run` 隐式启动）会 spawn 两个 runtime，第二个句柄覆盖第一个，孤儿进程的 reader 线程甚至可能挂到胜者的进程上。
2. `close()` 在从未 start 时直接返回，不失败等待者：start 之前创建的订阅在 close 后 `next()` 以 50ms 轮询死循环，永远挂起。且 close 可重启——close 之后 `start()` 会静默再 spawn，违反 TS 侧已文档化的 terminal 契约。
3. initialize 的 `serverInfo` 校验是全可选的 pydantic 模型，`{}`、`null`、残缺对象全部静默通过；`session.event` 的 envelope 非 dict 时被静默跳过，`assistant/message` 缺 content 时返回 `final_response=""` 的成功结果。
4. 每次 `run()` 铸造一个新 session id，而协议没有 `session/close`，runtime 侧的 agent 与会话归属跟踪永不回收；teardown 梯子也只有 1s 的 shutdown 超时，没有 stdin EOF 宽限。

## Decision

`start()` 把参数与环境预算移到锁外，spawn、句柄赋值与 reader/stderr 线程注册全部收进 `self._lock`，并复查句柄——并发 `start()` 恰好 spawn 一个 runtime。`RelayHarness.start()` 同样以 `threading.Lock` 串行化，重复 initialize 不再可能。

`close()` 置位 `_closed` 并成为 terminal：之后 `start()` 抛 `TransportClosedError("Relay Harness runtime client is closed")`；`_proc` 为 None 时也失败等待者再返回。teardown 梯子对齐 TS：shutdown 请求（`shutdown_timeout_seconds`）→ stdin EOF 等待 `eof_grace_seconds=6.0` → terminate 等待 `terminate_grace_seconds=3.0` → 强杀。两个字段进入 `HarnessConfig` 与 `RelayHarnessConfig`，不是硬编码 tunable。

models 的 `ServerInfo.name/version` 变为必填 `str`，`InitializeResponse.serverInfo` 必填；`initialize()` 捕获 `ValidationError`/`TypeError` 转抛 `SdkProtocolError("initialize returned no server identity: …")`，消息与 TS 对齐。`api.py` 新增 `_validated_session_event`：envelope 必须是含字符串 `type` 的 dict，`assistant/message` 必须携带 kind-tagged content blocks，畸形即抛 `SdkProtocolError`；`final_response` 删除 `data.content` 回退，固定读 `data.message.content`——校验先行后该回退已是不可达的防御路径，单侧保留违反两侧单一读取路径的约定。

`HarnessClient.session_close(session_id)` 镜像 TS 的 `session/close` 请求（未知 id 由 runtime 报错，调用方只能关闭自己创建的会话）；`RelayHarness.run()` 在未传 `session_id` 时 finally 收口自动铸造的会话——调用方无从引用一个自己看不见的 uuid，显式命名会话保持调用方所有。

## Alternatives considered

**给 close 保留可重启语义并让 `RelayHarness` 失败后换新 client。** TS 的 `RelayHarness.start()` 确实在握手失败后替换 client 实例，但 Python 的低层 `HarnessClient` 没有对应的重建入口，补齐重建路径属于新增能力而非收紧；预发布立场选择契约对齐（close 即 terminal），多 runtime 的消费者应持有多个 client。

**保留 `data.content` 回退并在 TS 侧复制同一回退。** 否决：一旦 Python 校验落地，回退即死路径；让 TS 复制一条死路径会把"信任 TypeScript 边界"规则倒置成双向防御性重复。

## Consequences

并发 start 从竞态双 spawn 变为串行单 spawn；第二个调用方阻塞一个 spawn 时长。close-before-start 的订阅从永久挂起变为立即 `TransportClosedError`——这正是两侧既有文档声明的行为。异常 teardown 从约 1s 变为最长 6s+3s 的宽限梯子，只拖慢异常路径。面对不守协议的 runtime，Python 从静默成功变为响亮失败。`run()` 返回后自动铸造会话的 agent 被 dispose；显式 `session_id` 路径行为不变。既有 fake-bridge 测试补齐了 `serverInfo.version` 与 `data.message.content` 的真实 runtime 形状。
