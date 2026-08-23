# 手机远程

[English](README.md) | 中文

扫描桌面端**远程**弹窗里的二维码，会打开本目录独立的 `mobile/web` SPA，而不是官方四栏 `dsh web` 界面。

## Web

1. 在桌面端打开远程，选择局域网或 HTTPS 中继模式。
2. 使用系统相机或浏览器扫码，密钥只保留在 `#offer=` 中。
3. 通过 3180 端口或中继登录后，服务端返回本目录的 `index.html`；`/api/*` 和 WebSocket 流量仍代理到本机 `127.0.0.1:3080`。
4. 开发时，`pnpm run test:desktop` 会运行 `mobile/web/**/*.test.js`。

中继必须使用 HTTPS。流量会经过中继运营方；这不是会话内容的端到端加密。

## Android

应用内扫码和原生页面尚未实现。请使用系统浏览器打开配对链接，不要用 WebView 包装官方界面。
