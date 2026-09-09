# Agent Note：sessionListMetadata 投影改为 baseline-only

Status: implemented

[English](2026-09-03-session-list-metadata-baseline-only.md) | 中文

## 问题

网关的投影变更流会为每个状态变化的单元生成一个 `session/projection` mux 帧，包括自己的 `sessionListMetadata` 单元。该单元在每条用户消息（`lastPromptAt`）和 blank→nonblank 翻转时都会变化，因此每个事件都会向每个 mux 订阅者推一帧。而没有任何客户端消费这个 key：会话行的 blank 与 recency 来自 `host/session-added`、`host/session-status`、`user/message` 活动帧以及 `session.list` / `session.history` 投影块；全仓搜索确认 `sessionListMetadata` 变更帧的读取者为零。同属网关的 `imageLimits` 单元本就不产生帧（其 `apply` 保持状态引用，注册表从不通知），两个网关自有单元在同一 wire 面上形成不对称。

## 决策

`api-proxy.ts` 的变更流广播现在跳过一个声明式的 baseline-only key 集合（`sessionListMetadata`、`imageLimits`），两个单元的注册处也都注明了该标记。值仍然和以前完全一样通过基线到达客户端——`session.list` 行与 `session.history` 尾页投影块——因此客户端零改动、没有任何数据变得不可得；被移除的只有 wire 帧。`imageLimits` 虽然注册表从不通知也一并列入，让两个网关自有 baseline-only 单元在同一处声明，并覆盖未来某次让 `apply` 返回新引用的改动。

## 备选方案

**把过滤下沉为 session-projection 注册表上的注册标记。** 暂不采纳：注册表的变更流还有其他监听者，消费面各不相同，baseline-only 是载体侧的投递决策；注册表层标记会为一个载体的需求扩宽 seam 包契约。

**继续广播、让客户端忽略该 key。** 不采纳：在每个订阅者处忽略帧仍然按会话重复支付流量，并且继续保留一套死的帧词汇。

## 后果

每条用户消息和 blank 翻转的投影帧不再到达 mux 订阅者，在最繁忙的投影上为每个事件、每个订阅者省掉一帧。今天没有任何读取者会因此失去数据，pre-release 立场允许不加兼容垫片直接收紧 wire。`api-proxy-mux.spec.ts` 的卫生用例钉住帧缺席，`api-proxy-projections.spec.ts` 保留 `test/last-user` 推送断言，防止过滤过宽。
