# Relay

Relay 是一个面向普通用户的通用 Agent：用户只需用自然语言描述需求或引入文件，Relay 负责补全上下文、执行任务、验证结果并交付。

产品原则：

- **傻瓜式可用**：不要求用户理解 Prompt、项目、模型或 Agent 工作流。
- **chat + work**：chat 用于对话，work 用于持续执行任务。
- **无项目心智**：work 不要求先建项目；文件与文件夹作为一次 work 的显式上下文引入。
- **Prompt Enhancing**：用户提交前可主动点击按钮，基于当前上下文优化草稿，但不会自动提交。
- **长期记忆**：记住用户真正需要长期保留的信息；具体实现路径待专项讨论。
- **模型路由外置**：agent 只消费中转调度项目的接口，不设计其内部路由算法。

- [Harness 实现](relay-harness/README.md) — 基于 DeepSeek Harness 的 agent runtime 与桌面/Web 壳层
- [文档地图](docs/README.md)
- [领域上下文](docs/CONTEXT.md)
- [产品体验](docs/product/product-experience.md)
- [Agent 架构](docs/agent/overview.md)
- [当前架构决策](docs/adr/README.md)

