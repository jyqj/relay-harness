# Ghostty Web 终端

[English](README.md) | 中文

本目录是浏览器适配层，使用与 Android 相同的官方 `libghostty-vt` C ABI；它不是 xterm 兼容层。

- `runtime.ts` 管理单例 WebAssembly 实例和运行时 ABI 布局。
- `ghostty-write-pty.wasm` 是一个 112 字节的回调跳板，用于发送终端生成的 PTY 回复。
- `core.ts` 管理每个终端的 Ghostty 句柄，并将 C ABI 转换为渲染快照。
- `renderer.ts` 将背景和样式片段批处理为 Canvas 2D 帧。
- `surface.ts` 管理浏览器输入、IME、选择、滚动、尺寸、链接和光标闪烁。
- `fonts/` 内置仅含符号的 Nerd Font（MIT），由 surface 延迟注册，使提示符字形无需本机安装 Nerd Font 也能渲染。
- `vendor/` 只保存由 `apps/web/scripts/build-libghostty-wasm.sh` 可复现生成的产物。上游 pin 和许可证位于 `native/libghostty-vt/`；wasm 在构建信息中嵌入固定版本，ABI 测试会将其与移动端的 `VERSION` 核对。

浏览器行为保留在本目录，终端传输保留在现有客户端运行时中。不要把 React 状态加入渲染循环。两个 WASM 产物都是普通只读资源，不是可执行文件。
