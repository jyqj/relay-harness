# Agent Note: api-proxy 第一刀拆分

Status: implemented

[English](2026-08-26-api-proxy-first-split.md) | 中文

## 问题

`packages/host/apiproxy/src/api-proxy.ts` 已膨胀到 3,749 行，在单个模块里混入至少八个领域：RPC 信封管线、prompt 内容图片准入、session 列表投影、workspace 冲突词汇，以及整个 `createApiProxy` 处理器主体。每个领域的变更都落在同一文件，评审 diff 互相冲突，而且该文件作为最大的运行时模块与 client face 的消费面，锚定了 api 包循环。

## 决策

第一刀把四个耦合最低的辅助簇移入 `src/api/` 契约层旁的专注模块，`createApiProxy` 及其处理器主体原样不动：

- `src/rpc-envelope.ts` —— `ok`/`err` 结果包装、`frame` 铸造、`isAborted`、`MESSAGE_TYPES` 与消息边界 `paginate`。
- `src/prompt-content.ts` —— `durablePromptContent` 批量图片准入与持久事件图片搜索（`messagesHaveImage`、`referencedImage`）。
- `src/session-list.ts` —— `DEFAULT_COLD_BLANK_PROBE_MAX_BYTES`、精确元数据折叠（`applySessionListMetadata`、`sessionListMetadata`）、`sessionListFields`、`summarize` 与尺寸门控的冷探测（`summarizeCold`）。
- `src/workspace-views.ts` —— preset/cwd/name 三类冲突、`presetError` 与 workspace wire 投影（`workspaceNotFound`、`workspaceView`、`changedWorkspaceView`）。

同日第二刀再移出四个簇：`src/model-catalog.ts`（`buildModelCatalog`）、`src/frame-queue.ts`（`FrameQueue`、`assertJsonArgs`、`subscribeSession`）、`src/approval-questions.ts`（待处理审批/问词条目及其校验）、`src/history-views.ts`（`viewFor`、`backscanArgs`、`historyPage`、`DEFAULT_MAX_MESSAGES`）。

`src/index.ts` 直接从 `session-list.ts` 导入 `DEFAULT_COLD_BLANK_PROBE_MAX_BYTES`；`api-proxy.ts` 不保留 re-export。搬移是代码等价的：只有导入、export 关键字与模块文档注释发生变化。

## 已否决的替代方案

**先按领域拆 `createApiProxy` 处理器主体。** 那是终态，但每个处理器都闭包引用 `ctx`、共享注册表与相邻助手；在没有辅助模块垫底的情况下在那里下刀只会把耦合撒得到处都是。推迟到辅助缝就位之后。

**等循环反转落地再拆。** 本拆分与 [API 包循环反转](../../proposed/architecture/2026-08-26-api-package-cycle-inversion.md) 相互独立：无论循环工作走哪个方向，这一刀都在缩减文件，而且缩小 apiproxy 让后续处理器拆分更小。

## 后果

`api-proxy.ts` 两刀后降到约 3,150 行，导入面减少二十余个现已模块局部的依赖。四个新模块是评审者一遍可以读完的单领域文件，session-list 与 workspace 簇的增长从此有了明确归宿。处理器主体仍是巨石；本笔记的范围到辅助缝为止。按文件覆盖率门禁对新增模块照常生效——同一批测试执行同一段被搬移的代码。

## 测试

包工程与 host 聚合的 `npx tsc -b` 均通过；apiproxy 全套测试（20 个 spec 文件、389 个用例）原样通过——这正是代码等价搬移的意义。
