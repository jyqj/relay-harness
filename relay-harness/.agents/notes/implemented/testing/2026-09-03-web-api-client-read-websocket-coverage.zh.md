# Agent Note: WebApiClient.readWebSocket 获得解析器覆盖

Status: implemented

[English](2026-09-03-web-api-client-read-websocket-coverage.md) | 中文

## 问题

`WebApiClient.readWebSocket` 是浏览器端唯一的线上解析器：web 客户端接收的每一条 mux 与 host 下行帧都要经过它的 JSON 解析、两级 zod 校验和基于 wake 的 inbox。此前它的行为只是通过 `client-apply.client.spec.ts` 的组装循环被顺带覆盖，若干解析器保证在任何地方都没有直接见证：畸形 JSON 帧必须被丢弃且流不中断；JSON 合法但 payload 未通过帧 schema 的帧必须以同样方式丢弃；`CONNECTING` 阶段（尚无任何帧时）的 abort 必须关闭 socket 并结束流；服务端在 `open` 之前到达的 close 必须结束流且不悬挂。

## 决策

`packages/client/connection/tests/web-api-client.client.spec.ts` 直接驱动 `WebApiClient.readWebSocket`，使用一个手动驱动的 `StubWebSocket`（由测试触发 `open`/`close`/`receive`；不像 `client-apply.client.spec.ts` 的 fixture 那样自动 open）。五个探针覆盖：畸形 JSON 被丢弃并打出 `console.error`，随后一条合法帧仍然 yield；schema 不合法的 payload 以同样方式丢弃，且坏帧都不会到达 envelope 观察者；`CONNECTING` 阶段 abort；`OPEN` 阶段 abort（`onOpen` 已触发后）；open 前的 close 结束流且 `onOpen` 从未调用。探针同时断言 `onEnvelope` 只见到通过校验的帧，固定两级解析"先丢弃、后观察"的顺序。

## 已考虑的替代方案

**扩展 `client-apply.client.spec.ts` 已有的 WebSocket 覆盖。** 拒绝：该 spec 通过 `apply()` 断言组装后的循环行为；解析器契约需要直接的 socket 控制（不自动 open、`CONNECTING` 中 abort、open 前 close），独立 spec 也避免浏览器半边的文件再次膨胀。

**通过 `ConnectionController` 连真实服务端测试。** 拒绝：真实载具对解析器不提供 stub 无法确定性产生的额外证据，且重连/退避机制会与"丢弃后继续"的断言交织。

## 后果

浏览器帧解析器的回归——畸形帧卡死或杀死流、丢弃帧的 `console.error` 消失、abort 或提前 close 使生成器悬挂——现在会让一个聚焦的 keyless 套件失败。`readWebSocket` 剩余未被见证的分支是二进制（非字符串）消息数据，它与畸形 JSON 共用同一条丢弃路径。
