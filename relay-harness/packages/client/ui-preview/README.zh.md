# @relay-harness/rlh-client-ui-preview

[English](README.md) | 中文

右边栏 Browser occupant，挂在 `surfaces.browser`（`single`，`session-maybe`，由 ui-surfaces 声明）。仅桌面预览 http(s) 文档。渲染进程拥有地址栏并上报宿主矩形；Electron 通过 `window.shell.preview*` 把 `BrowserView` 贴在该矩形上。约定：[slot 系统标准](../../../.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.md)。

访客页文档可以是任意 `http(s)` URL；Harness 主窗口仍限制在 loopback。`file:` 及其他非 http(s) 文档导航会被取消。远程 CDN 的子资源（字体、脚本、图片）允许加载，以便 Vite/Next 应用能渲染。访客页使用按会话 cwd（缺失时为 `shared`）sha256 散列的 persist 分区（`persist:rlhd-preview-` 前缀），不携带用户 API key（与 harness web 相同：凭据请求不跟随重定向）。非 Electron 时，空态卡和本面板显示 `Browser previews are only available in the desktop app.` occupant 挂载期间持续列出发现的 loopback 端口；每条发现结果仅为 `{ url, port }`（无进程名；Unix `lsof` 也未接入）。点击芯片会打开或导航访客页。铬是图标后退／前进／刷新（加载中为停止）、回车提交的 `Input`（占位「搜索或输入 URL」）、访客页尚未打开时也可使用地址栏 URL 的系统浏览器图标，以及「更多」菜单：强制刷新、开发者工具、打开／关闭独立预览窗口、显示／隐藏设备工具栏、选取元素、开始／停止录制、截图、外观（系统／浅色／深色）、缩小／`N%`／放大／重置、清除 Cookie、清除缓存。「显示设备工具栏」通过 `previewResize`（`setBounds`）把 guest `BrowserView` 收到设备矩形（工具栏 32px、轨道 10px），并在剩余 `.host` 信箱空位上绘制该铬（`--rlw-alias-bg-base`）；不调用 CDP `Emulation.setDeviceMetricsOverride`。选取元素在存在 `appendComposerText` 和 session 时把 markdown 插入输入框。录制是宿主渲染进程的 `MediaRecorder`；帧经 IPC 到达，成品落在 `userData/preview-recordings/`。占用隐藏条件是 `overlayOpen || pipOpen`（「更多」、设备预设菜单、PiP）。主框架加载失败显示「无法打开此网站。」。guest 的 `did-navigate`／`did-navigate-in-page` 发出 `shell:preview-state-change`，地址栏和前进／后退跟随页内导航。非活动或被渲染进程 chrome 遮挡的 surface Tab 会保留 guest，同时通过 `previewHide` 移除原生视图；关闭浏览器 Tab 卸载面板并调用 `previewClose`。

`/client` 导出表层只包含插件主体（`apply`／`inject`）及约定类型；PreviewPanel 仍由 slot 注册封装在包内。

录制失败会标明失败操作；桌面录制桥不可用时报告 Host 启动被拒绝。同一预览正在启动或停止期间再次启动会报告冲突，已经录制时再次启动则保持幂等。录制只会在首张 JPEG 解码并绘制完成后开始，而不是仅在尺寸到达后开始。等待启动后，渲染器会在创建编码器或停止帧流前确认同一录制实例仍拥有该预览。已放弃启动的晚到结果不能复活其编码器，也不能停止相同预览 id 的替代录制。启动等待超时时，停止流程会先请求 Host 取消捕获，再释放录制位置；取消失败时，报告原因保留两项错误。Host 停止结果为 `ok: false` 时，与 IPC 拒绝一样会使停止操作失败；渲染器不会保存或报告成功，但仍释放本地媒体资源。每个录制实例独立于 MediaRecorder 持有其 canvas 捕获流。清除录制时会停止全部捕获媒体轨道，包括编码器初始化/启动失败以及停止/保存失败的路径；重复停止不会保留捕获流或帧订阅。

## 模型体验

无。Browser 面板只预览 http(s) URL；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包（package）既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **同一时间只有一个访客页**：surfaces store 只持有一个 preview；occupant 内没有标签条。
- **设备工具栏不模拟 CSS 视口**：`previewResize` 把 `BrowserView` 收到缩放后的可见矩形。预设放不进宿主时，页面按该较小视图排版；没有 CDP `Emulation.setDeviceMetricsOverride`。
- **发现芯片没有进程名**：每条结果在所有平台都是 `{ url, port }`；Unix `lsof` 也未接入。
