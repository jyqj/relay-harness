# Agent Note: Runtime resource bounds for turns, Code Mode, and SDK transport

Status: implemented

[English](2026-08-31-runtime-resource-bounds.md) | 中文

## Problem

三条只存在于执行局部的路径会在没有完整上限的情况下保留由攻击者或工作负载控制的数据。一个 turn 可以通过工具调用或 steering 持续启动模型请求；Code Mode binding 值会绕过外层输出账本；TypeScript SDK 会接收没有终止换行符的 JSON-RPC frame，并保留任意数量的未结算写入和 subscription notification。最终结果截断无法保护这些更早的 commit point。

## Decision

已经随发行版提供的 token budget controller 也会在 `agent/pre-step` 强制 `maxStepsPerTurn`，默认值为 64。它从持久 `step/start` 事件重建计数，并在第 65 次请求前抛出异常，因此 resume 无法重置硬上限；既有的内存 continuation 启发式仍保持独立。

worker-thread Code Runtime 新增 `maxBindingBytes`，默认值与既有外层输出上限相同，均为 64 MiB。宿主会在调用 binding 前计量每个已解码参数，并在把无损 resolve 值编码回 worker 前计量结果。超限值会变成有类型的 binding rejection，而不是 structured-clone 流量或程序可见中间状态。

`JsonRpcLineTransport` 默认把单条入站或出站 frame 和未结算输出总量限制为 64 MiB。partial input 在换行符到达前就按字节计量；输出字节持续记账到 stream callback 结算。资源失败会关闭逻辑 transport，并可由 owner 观测。TypeScript SDK 会下传这些限制，并把每个 subscription 限制为 4096 条排队 notification；溢出只让该慢 subscription 失败并解除注册，同时保留已准入前缀。

独立的 Python SDK 会原生实现同一组默认值，而不是依赖 TypeScript client：byte-mode stdout 分帧会拒绝超大完整行或没有终止换行符的 partial frame；同步 stdio writer 会在等待写锁之前预留编码后的字节，并循环直到每个字节都写完；每个 subscription 使用 4096 项队列。底层 write 返回 `0` 或 `None` 会在 flush 前 fail closed。旧式全局 notification 与 incoming-request 通道同样最多保留 4096 项，溢出时保留已准入前缀，并且只让各自 consumer 失败。关闭 subscription 会原子解除注册、丢弃前缀，并让后续读取收到有类型的关闭错误。`RelayHarnessConfig` 会把五项限制全部传给底层 client。runtime wheel 的默认 Cordis composition 还会显式固定 server 侧 frame 与写入限制。

64 MiB frame 和 binding 默认值复用 runtime 既有的外层输出兼容上限，而不是新增更严格且没有文档依据的 payload 限制。64-step 默认值与随发行版提供的固定 Ralph round 上限一致；4096 则复用仓库既有的大集合上限，同时让保留量保持有限。

## Alternatives considered

**依赖进程内存与 Node stream backpressure。** 未采用，因为 `Writable.write(false)` 只是建议，JavaScript 队列仍可以继续增长；进程 OOM 不是资源契约。

**截断 binding 值或 notification。** 未采用，因为二者都是规范的类型化数据。显式有界失败可以保留语义；静默截断会伪造看似有效的值或不完整事件流。

**把 turn 上限放入 AgentLoop。** 未采用，因为既有生命周期策略插件已经拥有 continuation 预算。通过 pre-step seam 统计持久 step 事件可以保持 loop 可替换，也允许自定义 composition 有意替换该策略。

**采用小得多的新默认值。** 在没有工作负载证据时未采用。复用现有产品上限可以关闭无界增长，又不会制造无关兼容性破坏；部署仍可显式降低每项限制。

## Consequences

普通发行 composition 中每个 turn 的模型请求数有限；默认 worker Adapter 的 Code Mode binding 无法保留或 clone 无界规范值；两个 SDK client 都拥有显式 transport 与 notification 保留失败点。移除 controller 的自定义 Agent composition 会重新承担缺失的 turn 策略。恶意 worker 参数会在 worker→host structured clone 后才被计量，因此 worker heap 上限仍是更早的兜底；未来可以在不改变公开约定的情况下通过 wire-token preflight 更早拒绝。Python 仍保留独立的底层全局 notification 与 incoming-request API，但两条队列都不再无界。host 构建完成后，`pnpm run test:python-carriers` 会把缺失 exe/node 产物变成失败；普通 source-only pytest 仍保留独立 skip，避免贡献者为无关 SDK 修改重新构建 200+ MB 可执行文件。
