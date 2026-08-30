# Agent Note: 远程配对放在设置旁边的手机控件上

Status: implemented

[English](2026-08-14-settings-remote-section.md) | 中文

## 问题

设置 → 远程那一页带着端口、局域网地址、原始配对链接和令牌轮换，把配对做成了技术配置。用户只需要打开远程、选局域网或服务器中继、扫二维码。把它埋在设置里，控件看起来没做完，也把手机真正要看的东西藏起来了。

## 决策

Remote 的 dormant UI 实现是 `@relay-harness/rlh-client-ui-settings-remote` 中受桌面门控的 `sidebar.footer.action`（`id: 'remote'`），设计位于设置齿轮旁，包含开启／关闭、LAN／中继、配对二维码与已连接设备控件。它不属于已交付 composition：web-app 补丁注释掉 `ui-settings-remote`，桌面 preload 不暴露 Remote 方法，`REMOTE_FEATURE_ENABLED` 与 `remoteAvailable` 均为 false，主进程只构造 `createDisabledRemote()` 而非 `RemoteGateway`（[桌面输入框草稿查找与官方触发器](../bug-fix/2026-08-21-desktop-composer-draft-and-official-triggers.md)）。用户无法到达任何 Remote 控件或网络入口。

## 考虑过的替代

**保留完整的设置 → 远程页。** 否决：那一页把网关内部暴露给每一次配对。齿轮仍是产品设置；远程是配对动作。

**做在 Electron 铬架上。** 否决：官方侧栏已经拥有设置触发器；再做一个铬架按钮会重复配对窗的错误。

**把 `rlh web` 绑到 `0.0.0.0`，或重做原生聊天客户端。** 否决：Host 围栏没有鉴权，产品包装的是官方页。

## 后果

Dormant 包测试保留拟议控件行为，但不把它组装进产品。已交付 composition 的测试要求该行保持注释；Desktop config／IPC 测试要求投影始终 unavailable/disabled；标题栏、托盘、preload 与设置均不暴露 Remote 入口。
