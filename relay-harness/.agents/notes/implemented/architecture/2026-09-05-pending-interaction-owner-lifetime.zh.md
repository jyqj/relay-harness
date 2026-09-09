# Agent Note: 待处理交互的拥有方生命周期

Status: implemented

[English](2026-09-05-pending-interaction-owner-lifetime.md) | 中文

## Problem

Web question provider 接受可选 abort signal，因此 live Agent 可以合法地不带 signal 发起问题，再离开注册表，而该问题仍可回答并计入 session id 的待处理数量。Approval 存在相同生命周期缺口，之后复用该 id 的 Agent 不应继承旧等待。

## Decision

[API Proxy](../../../../packages/host/apiproxy/README.md) 为每个待处理 question 或 approval 保留精确 Agent 拥有方。Agent 注册表的释放事件只撤回属于该实例的等待。Question 以 `ASK_ABORTED` 拒绝，approval 经既有审计 resolver 结算 cancelled。两者均在通知客户端前移除条目，保留首次认领所有权，让迟到 rpcId 不再处于 pending 状态。

请求 signal 取消与 gateway 释放仍独立触发相同清理。Wire 投影只携带既有请求字段，不暴露保留的 Agent 对象。同 id 后继从自己的等待开始，非法回答不能认领任何现有等待。

## Alternatives considered

- **要求所有调用方自行构造取消 signal** —— 重复 Agent 注册表既有生命周期权威，仍使合法的可选 signal 调用不安全。
- **释放时只匹配 session id** —— 可能取消后继请求，而非正在释放实例的等待。
- **保留旧问题直到收到回复** —— 遗留待处理计数，并为运行时拥有方已经结束的工作接收答案。

## Consequences

每个待处理交互保留已存活 Agent 到结算时，清理后释放引用。服务到 mux 测试覆盖合法及非法回复、自定义答案、客户端取消、步骤取消、gateway 释放、无 signal 的拥有方释放和同 id 替换。这关闭 API Proxy 的高风险覆盖缺口，但不代表其全部分支已覆盖，也不替代浏览器验收测试。
