# Agent Note：跨组合、配置、运行时与会话的有效能力报告

Status: implemented

[English](2026-09-20-effective-capability-report.md) | 中文

## Problem

"已安装"、"已配置"、"当前健康"与"会话可用"是四个不同的事实，但此前没有任何表面把它们拼在一起。`rlh --dump-config` 只按 bundle 打印原始 patch 层，`pluginInventory/list` 只给 Loader 级的启用状态与 Fiber 阶段；二者都无法回答语义搜索、网页搜索或全文会话搜索在某个部署或会话里是否真正可用，也无法区分"未配置"与"坏了"。

## Decision

`@relay-harness/rlh-host-plugin-inventory` 独占一个报告构建器 `buildCapabilityReport` 和一份随附能力目录（`DEFAULT_CAPABILITY_CATALOG`）。报告对每个能力给出四级带证据的判定——`assembled`（组合后的 bundle 条目清单）、`configured`（组合后的条目配置，由各能力自己的谓词求值）、`healthy`（Loader Fiber 状态）、`session-available`（Host 工具注册表）——每级为 `yes`/`no`/`unknown` 并附带指明事实来源的证据字符串，最后折叠为一个 `effective` 状态（`absent`/`installed`/`standby`/`running`），且折叠规则绝不把 `installed` 向前传递。

两个表面共用该构建器。`pluginInventory/capabilities` 直接把已挂载的 Loader 树作为组合证据（配置已求值），因此已启动的 Host 能报告全部四级。`rlh --dump-capabilities` 复用配置 dump 的组合逻辑（含用户层与 `--patch` overlay，`!!js` 表达式不求值），把运行时级别报为 `unknown` 并打印一句明说的提示；需求谓词只读字面值，遇到表达式按未满足处理而不是猜测。

初始目录覆盖三项：code-index（要求 embedding endpoint；`resolveEmbeddingConfig` 的 `baseURL`/`model` 关闭开关即 configured 谓词）、网页搜索（`apiKeyEnv` 已设置）、全文会话搜索（`openAt` 不为 `never`）。

## Alternatives considered

**为完整 CLI 报告而真正启动 profile。** dump 模式存在的意义就是不启动、无副作用；为打印报告而启动会改变该 flag 的代价，并破坏坏 patch 文件时的恢复路径。诚实的 `unknown` 加上已启动 Host 的 remote 同时保住了两个约定。

**从插件 Config schema 通用推导配置需求。** schema 表达的是合法性，不是部署意图："embedding 缺失"是合法且有意义的关闭状态，不是校验失败。把每个能力的需求集中声明在一份目录里，让关闭开关语义留在报告中，而不是编进 schema 遍历器。

**新建一个能力报告包。** 构建器、目录与读取的 Remote 全部放在本就投影 Loader 状态的 inventory 包；CLI 本就依赖它，第二个投影之家只会拆散词汇表。

## Consequences

目录是固定允许清单：未声明的能力对报告不可见，session 级别读取的是 Host 的全局工具注册表而非按会话限定的工具集，因此受 preset 门控的上下文贡献（memory、code recall）尚未建模。部署若以目录之外的条目 id 挂载某能力，会一直报 `absent`，直到目录登记该 id。`pluginInventory` 为读取工具注册表新增了对 `@relay-harness/rlh-tools` 的仅类型 peer 依赖；在 `tools` 缺席处网关仍可挂载，该级报 `unknown`。新增目录条目无需 SDK 再生成：Typert 在构建时重新生成 Remote 产物。

`@relay-harness/rlh-app-boot` 新导出的 `composeEntriesWithProvenance` 现在拥有 `renderConfigDump` 所渲染的配置 dump 组合循环；其来源标注为 CLI 报告的 assembled 证据供料。

## Verification

构建器单元测试覆盖各级别在纯组合、已启动、Fiber 失败、已停用与缺工具集输入下的行为，包括"installed 永不 running"的折叠性质。网关测试断言第二个 Remote 方法与已挂载 Loader 证据；CLI 测试覆盖参数路由与经由共享构建器的真实 web profile 组合。改动包的定向 `tsc -b` 通过；dump 与 Remote 未新增模型可见行为，故未扩展组装应用快照覆盖。
