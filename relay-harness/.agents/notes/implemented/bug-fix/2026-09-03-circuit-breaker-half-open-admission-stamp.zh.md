# Agent Note: Circuit breaker 以准入 stamp 结算 half-open 记账

Status: implemented

[English](2026-09-03-circuit-breaker-half-open-admission-stamp.md) | 中文

## Problem

`CircuitBreaker.record()` 按结算时 breaker 的状态路由每个 outcome，而不是按请求获准时所处的状态。closed 时获准的请求（`check()` 通过，未占用 probe slot）可能在另一个 outcome 触发 trip、breaker 进入 half-open 之后才结算。这种过期 outcome 到达时，`record()` 会无条件 shift 一个 half-open probe：closed 状态的过期 success 因此会在任何真实 probe 报告之前关闭 breaker，过期 failure 则会在它从未 claim 的 probe slot 上触发 trip。两条路径都让 trip 前的在途流量决定 recovery，而正是这些流量的 outcome 促成了 trip。closed 状态的 sample 之前也只按时间淘汰，不按数量封顶，长时间压在 failure 阈值之下的 provider 可能保留无上限的 sample 数。

## Decision

`check()` 现在返回一张 admission stamp——`{ state: 'closed' }` 或携带已 claim 的 probe lease 时间戳的 `{ state: 'half-open', probe }`——`record()` 按该 stamp 路由每个 outcome。closed 准入的 outcome 只进入 live window，且只在 breaker 仍为 closed 时触发 trip。half-open 准入的 outcome 只释放 stamp 指名的那个 probe slot（用 `indexOf` 加 `splice`，而非无条件 `shift`），也只有它能关闭或重新打开 breaker；probe lease 已被 reclaim 或重置的 outcome 找不到 slot，不改变任何状态。未携带 stamp 的 outcome 按 closed 准入处理，为直接使用 `CircuitBreaker` 的调用方保留原有契约。live window 另外最多保留 1000 个 outcome（`MAX_SAMPLES`，固定的内存 bound，不是部署 tunable），超出后按最旧优先丢弃。

插件把 stamp 贯通到端到端。`agent/request` waterfall 按 agent 与 provider 保存每张 admission；由于一个 agent 同一时刻至多驱动一个 model request，`agent/request-error` 与已提交 `assistant/message` 的 outcome 通过对该 per-agent per-provider 队列做一次 FIFO shift，结算的正是它之前那个请求的 stamp。被 shed 的请求从不准入，因此它的 `CIRCUIT_OPEN` error 找不到 stamp、不记录任何内容——此前被 shed 的请求会在 half-open window 里记入一条 connectivity success sample。未被 registry 跟踪的 success 来源回退为 closed 准入，继续为这类流量记录 success。

## Consequences

trip 前的在途流量不再决定 recovery：half-open 只在真正 claim 了 probe 的请求的 outcome 上关闭或重新打开，任何 outcome 都无法释放它从未 claim 的 slot，两个过期方向与 sample cap 均有单测钉住。retention cap 让每 provider 的内存与 window 配置无关地有界。代价是：请求期间 probe lease 到期的真实 outcome 会被丢弃而不是计数，被放弃的 probe 因此把 recovery 推迟一个 lease（`openMs`），而不是按到达时刻裁决——既有的 reclaim 语义本就拥有这段延迟。插件的 FIFO 关联依赖 loop 的每 agent 单在途请求性质；未来 loop 若对同一 agent 发出并发请求，关联 key 需要在 agent 与 provider 之外扩展。

## Alternatives considered

- **保留按结算时状态路由，由插件不记录过期 outcome**——不知道准入状态，breaker 就无法区分过期 outcome 与 probe outcome，该 defect 会为其他所有调用方继续留在类里。
- **按 request id 关联准入**——`agent/request-error` 携带 `turn`/`step`，但 `assistant/message` session event 只携带 provider source，今天不存在共同身份；per-agent FIFO 顺序复用了 loop 已保证的顺序。
- **只丢弃 shed 请求的 success sample，而不是跳过无 stamp 记录**——half-open shed error 属于同一类错账，只有 admission stamp 能区分它们，所以 stamp 必须先存在，这个区分才能在任何位置被强制。
