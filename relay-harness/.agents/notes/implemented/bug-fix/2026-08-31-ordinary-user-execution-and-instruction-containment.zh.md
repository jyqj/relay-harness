# Agent Note: Ordinary-user execution and instruction containment

Status: implemented

[English](2026-08-31-ordinary-user-execution-and-instruction-containment.md) | 中文

## Problem

两个可选的开发者机制越过了普通用户的信任模型。通用 Workflow 工具把模型编写的 JavaScript 交给 worker-thread 引擎，而其中的 `node:vm` 只塑造脚本 API，不会约束恶意代码；base bundle 却公开了该工具。固定 Ralph 脚本使用同一引擎，但不接收模型编写代码，因此不属于这个缺陷。另一方面，`agent-instructions` 会跟随仓库控制的最终组件 symlink，指向宿主可读取的任意目标，因此打开一个仓库就可能把项目根之外的内容放进模型请求。后一行为曾是明确接受的取舍，但它与 Relay 的显式 File Context 和普通用户数据访问方向冲突。

## Decision

普通用户 composition 不公开任意模型编写的 Workflow 执行。`rlh-base` 省略 `tool-workflow` 及其包依赖，同时只为 `tool-ralph` 的部署方固定脚本保留 `workflow-worker-thread`。随发行版提供的 `standard` 与 `code` preset 不包含通用 Workflow 工具。Cordis 创造 preset 保留通用工具作为显式 developer opt-in；用户自行编写的 profile 或 preset composition 仍可主动挂载它。Workflow seam 与 worker 实现继续可用；本决策收窄不安全 Consumer，而不移除安全的固定策略 Consumer。

指令候选文件继续支持 symlink，但解析后的目标必须属于允许根。用户全局候选文件受规范化 `$RLH_HOME` 约束；项目候选文件受规范化的已发现项目根约束。`additionalAllowedRoots` 接受显式绝对路径根，用于共享规范指令文件，并参与 `baselineIdentity`；因此，授权改变后会重新校验可见基线。宿主发现流程会解析候选文件与允许根、检查包含关系、对已检查的规范目标执行 stat 并读取；提供方发现流程使用 `FileSystem.resolve()` 身份与 `FileSystem.contains()`。树外目标或非文件目标会被确认为不存在，因此对账会移除之前可见的候选文件；提供方故障仍属于暂时不可用。

本决策部分取代[无条件跟随指令 symlink](../feature/2026-07-21-follow-instruction-symlinks.md)，并收窄[动态工作流](../feature/2026-07-05-dynamic-workflows.md)中关于默认 composition 的部分。同根的 `CLAUDE.md → AGENTS.md` 镜像与显式授权的共享文件仍受支持。

## Alternatives considered

**在普通 preset 中保留 Workflow，只添加提示词警告。** 未采用，因为提示词文本无法约束进程权限。模型编写的脚本一旦逃逸 `node:vm`，就已经绕过工具、approval 与 sandbox seam。

**完全删除 Workflow。** 未采用，因为该 seam、journal、取消机制与开发者用例仍有价值。显式 developer composition 能表达信任选择，而不会把它强加给普通会话。

**禁止所有指令 symlink。** 未采用，因为同根镜像与 operator 控制的共享文件是合理用例。规范目标包含关系既保留这些场景，也关闭隐式树外披露。

**只由 `ctx.fs` 负责读取约束。** 未采用，因为随发行版提供的文件系统策略会约束写入，却有意放行读取。`agent-instructions` 自己负责自动准入模型内容，因此必须执行自己的来源准入规则。

## Testing

base bundle 测试会拒绝通用 Workflow 工具及其依赖，同时要求 worker 与固定 Ralph Consumer 保留。随发行版提供的 preset 测试会拒绝 standard 与 code 中的通用工具，同时要求 Cordis developer preset 保留它。agent-instructions 测试覆盖宿主与 `ctx.fs` 的树外拒绝、显式附加根授权，以及无效的相对授权根；完整包测试继续覆盖基线与对账行为。

## Consequences

普通会话无法通过随发行版提供的 composition 向不具备沙箱的 Workflow 引擎提交任意模型编写脚本，同时固定 Ralph 策略仍可使用。开发者仍保有显式 opt-in；未来的独立进程／容器 Adapter 可在不改变工具 Interface 的情况下恢复安全的通用暴露。仓库默认无法再借指令 symlink 把任意宿主可读内容准入模型历史。若部署有意共享项目或 Harness home 之外的指令，必须列出包含该文件的规范根；改动该列表会按设计改变持久基线标识。
