# Relay Harness

[English](README.md) | 中文

Relay Harness（`rlh`）是一个开源的 agent harness（智能体框架），由 MIT 许可的 DeepSeek Harness 更名而来（上游版权信息见 [LICENSE](LICENSE)）。

它采用**一切皆插件**的架构，并由 [Cordis](https://github.com/cordiverse/cordis) 驱动，其设计参见论文 [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper)。

## 开发者预览

Relay Harness 目前处于 _开发者预览_ 阶段，正在快速迭代。**未来将出现破坏兼容性的变更。**

## 运行

### 通过 `npm` 运行

安装 `Node.js`，然后运行：

```sh
npx @relay-harness/rlh web
```

该命令默认会在 `http://127.0.0.1:3080` 启动 Web UI，本机启动时还会用默认浏览器打开页面。通过 SSH 启动时只打印宿主机 URL，因为本地转发地址由 SSH 客户端或编辑器持有。传入 `--no-open` 可仅运行服务器而不打开浏览器。详见 [Web UI 指南](docs/user/guide/index.md)。

### 从源码运行

如需从仓库源码运行：

```sh
git clone https://github.com/jyqj/relay-harness.git
cd relay-harness
pnpm install
pnpm run build
pnpm rlh web
```

`pnpm run build` 会准备仓库产物。`pnpm rlh web` 会直接使用这些已构建产物，不会重新构建。

## 社区与支持

- 欢迎通过 [GitHub Discussions](https://github.com/jyqj/relay-harness/discussions) 提交反馈或 bug 报告。
- 为你的插件仓库添加 [`rlh-plugin`](https://github.com/topics/rlh-plugin) 话题，便于被发现。
- 欢迎加入 <a href="https://discord.gg/Ycq5dCaS4">Relay Harness Discord 社区</a>。

## 参与贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 开发

请先阅读[开发指南](docs/development.md)与[架构文档](docs/architecture.md)。

面向 agent：请遵循 [AGENTS.md](AGENTS.md)。

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
