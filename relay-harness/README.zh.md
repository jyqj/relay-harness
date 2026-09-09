# Relay Harness

[English](README.md) | 中文

Relay Harness（`rlh`）是一个面向普通用户的开源通用 agent harness（智能体框架）。用户只需用自然语言描述目标、按需引入相关文件，即可获得经过验证的结果，无需学习 Prompt 工程或 agent 内部机制。

它采用**一切皆插件**的架构，并由 [Cordis](https://github.com/cordiverse/cordis) 驱动；其设计参见论文 [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper)。

## 产品体验

- **默认简单：**Chat、Work 与 Library 构成普通产品路径；用户主动需要时才会看到高级实现控件。
- **Chat 与 Work：**Chat 支持连续对话。Work 拥有独立任务、执行状态、问题、文件、输出、验证和恢复，且不要求创建 Project。
- **显式上下文：**用户向当前 Chat 或 Work 引入文件与文件夹，而不是授权系统隐式扫描整台设备。
- **Prompt Enhancement：**用户可以根据当前上下文优化未提交草稿，审阅差异与来源，接受或撤销建议，并始终控制是否提交。
- **本地治理：**权限、记忆、上下文证据、检查点与验证都保持显式且可审计。

机器可读的[功能状态](docs/feature-status.json)索引实现范围与证据引用。其验证器检查路径与标记，而非执行结果；验证结论另以当前测试、构建、平台运行与提供方运行结果为依据。

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
cd relay-harness/relay-harness
pnpm install
pnpm run build
pnpm rlh web
```

`pnpm run build` 会准备仓库产物。`pnpm rlh web` 会直接使用这些已构建产物，不会重新构建。

## 仓库与文档

Git checkout 是外层容器。TypeScript runtime monorepo 位于其中的 `relay-harness/` 下；在该目录内，`apps/` 包含 CLI、Web 与 Desktop 应用，`packages/` 包含插件运行时，`docs/` 包含产品和实现文档。根 `.github/` 是唯一的 GitHub 自动化权威。

- 从[文档地图](docs/README.md)与[领域上下文](docs/CONTEXT.md)开始阅读。
- 当前实现约定见[架构](docs/architecture.md)与[子系统参考](docs/subsystems/README.md)。
- 修改仓库前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 与[开发指南](docs/development.md)。
- agent 遵循 [AGENTS.md](AGENTS.md)。

## 社区与支持

- 通过 [GitHub Discussions](https://github.com/jyqj/relay-harness/discussions) 提交反馈或 bug 报告。
- 为插件仓库添加 [`rlh-plugin`](https://github.com/topics/rlh-plugin) 话题，便于被发现。
- 加入 <a href="https://discord.gg/Ycq5dCaS4">Relay Harness Discord 社区</a>。

## 许可证

[MIT](LICENSE)

Relay Harness 由 DeepSeek Harness 更名而来，因此 [LICENSE](LICENSE) 保留了 MIT 条款要求的上游版权声明。

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
