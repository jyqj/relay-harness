# Agent Note: 工具资源意图与公平读写锁

Status: implemented

[English](2026-08-21-tool-resource-intent-locks.md) | 中文

## Problem

一元 `isConcurrencySafe(args)` 约定可以把调用声明为全局并行安全或独占，却无法表达常见关系：「不同文件可以重叠，同一文件不可以。」因此，文件系统 write、edit 与组合式字符串替换编辑器一直保持独占，使无关路径被串行化；若直接把它们标为并行，又会让同一目标 effect 与观察 policy 发生竞态。

资源身份必须来自提供方解析后的目标，而不是猜测参数名或使用原始路径拼写。等待期间的取消必须移除 waiter，声明多个资源的调用也不能死锁。

## Decision

`ToolDefinition.resourceIntents(args, exec)` 是可选的类型化预分派 resolver。声明它会让调用进入并行池。它在 `tools/pre-execute`、审批和单调 guard 之后运行，可以执行身份查找但不能变更资源，并返回规范、带 namespace 的 `{ key, access: 'read' | 'write' }` claim。解析错误会成为经过 post-execute 的工具失败；解析前或解析中的取消仍是 `ABORTED_BEFORE_DISPATCH`。

`ToolRuntime` 持有一张公平读写锁表，由原生调用、直接 `execute()` 调用和 Code Mode 嵌套分派共享。它会以 write 覆盖 read 的规则规范化重复 claim，按 key 排序后获取，并只在工具主体周围持有全部 lease。同 key read 可以重叠；writer 排除 reader 与 writer；排队中的 writer 会阻止后来的 reader 插队。取消会同步移除排队 waiter，按逆序释放已获取的多 key lease，且绝不调用等待中的主体。action 失败与取消都会释放全部 lease。

`rlh-tool-fs` 通过 `ctx.fs.resolve()` 解析 read、write 与 edit claim，使用和主体相同的逐会话 cwd 语义，再把提供方 `FsTargetKey` 放入 `fs:` namespace。read claim 为共享，mutation claim 为独占。`rlh-tool-str-replace-editor` 使用同一 namespace 与提供方 key，其中 `view` 为 read，三个变更命令为 write。既有文件系统 intent／CAS policy 仍在锁内运行。因此，同一会话对同一文件的两次编辑可以串行地全部落地：第二个 policy 决策会观察到第一次提交后的版本，而不是因可避免的陈旧版本竞态失败。

请求工具快照会连同定义的其他部分一起捕获资源 resolver。注册表替换不能改变已采样调用的资源行为。

## Alternatives considered

**让每项 mutation 继续全局独占。** 不予采用，因为无关文件承担了不必要的延迟，大型多文件变更也无法利用既有有界池。

**让 scheduler 根据常见参数名猜测文件 key。** 不予采用，因为工具使用 `file_path`、`path`、嵌套对象、远程标识和提供方特定解析。只有所属工具与提供方是可靠的身份边界。

**锁定原始路径字符串。** 不予采用，因为相对／绝对 alias、symlink 与提供方规范化可以用不同拼写指向同一目标。文件系统工具锁定解析后的 `FsTargetKey`。

**只在 `rlh-tool-fs` 内放置锁。** 不予采用，因为独立字符串替换编辑器与未来工具必须和同一批文件协调，Code Mode 也必须共享原生锁语义。

**在有序 prepare 阶段获取资源。** 不予采用，因为被同 key 阻塞的调用会占住 scheduler 的有序 lane，使后续独立 key 无法补入池。意图解析仍保持有序；获取发生在重叠的 dispatch 阶段、紧邻主体之前。

## Consequences

不同文件系统目标可以并发执行，同一目标的 read 与 mutation 则遵循一个公平顺序。工具 runtime 获得了不硬编码文件系统概念的通用资源词汇。声明错误 key 的工具仍可能竞态；该回调是受信任的能力约定，第一方文件系统工具从提供方派生 key。

锁只协调同一 `ToolRuntime` 中主动参与的工具主体。Shell 命令、外部进程和未声明同一 key 的工具仍在机制之外。资源 resolver 会在分派前增加一次提供方身份查找；文件系统主体仍会为实际操作再次解析，并保留既有 sandbox 与陈旧观察强制逻辑。

