# 手机远程

[English](README.md) | 中文

当前桌面构建暂缓交付手机 Remote。产品未组装 Remote 弹窗，`remoteAvailable` 为 false，主进程既不打开 LAN 网关，也不建立出站中继。本目录保留独立的 `mobile/web` 实现及其单元测试，作为 dormant 资产而非已交付网络入口。

## Web

`pnpm run test:desktop` 会在不启用该功能的前提下运行 `mobile/web/**/*.test.js`。Dormant 协议预期使用 fragment 中的 offer、本地网关和 HTTPS 中继，但桌面入口不会构造其中任何一项。

Dormant 中继设计要求 HTTPS。流量会经过中继运营方，而不会为会话内容提供端到端加密。

## Android

应用内扫码和原生页面尚未实现。请使用系统浏览器打开配对链接，不要用 WebView 包装官方界面。
