# ADR-0007：过渡期 API 路径必须携带可校验的退出条件

[English](0007-legacy-api-exit-conditions.md) | 中文

- **状态**：已接受
- **日期**：2026-09-20

## Context

API 层迁移期间并存两个面向客户端的方法面。Typert remote 组装层（`@relay-harness/rlh-api-remotes`）把生成的 `/remote` 贡献挂载为 `ctx.remote.<namespace>` 方法；API 代理（`packages/host/apiproxy`）在 `/api` 下提供 `RpcMethodMap` 方法。同一个业务域同时在两面应答时，每一面都可能长出自己的业务规则，而没有任何机制发现这个"临时"的第二面何时变成永久存在。

## Decision

1. 同时暴露在两个面上的业务域是过渡性的。它只有在下表占有一行时才被允许存在：这一行必须写明规则归属方、每个面上的现有消费方、迁移目标，以及一个机器可校验的退出条件。
2. 不允许以"兼容"为名、无表行地保留重复逻辑。可校验的不变量通过 [scripts/legacy-api-exit.ts](../../scripts/legacy-api-exit.ts) 执行（vitest 规格 `scripts/legacy-api-exit.spec.ts`，属于 `pnpm run test`）：重复域的集合必须等于已记录的 allowlist；客户端组装层挂载的每个 remote 贡献必须出现在 remote-wire 表中；[packages/client/connection/src/index.ts](../../packages/client/connection/src/index.ts) 中的 `PRIVILEGED_METHODS` 必须与钉住的方法清单一致。
3. 迁移一个域时，在同一变更中删除落选的面并移除其 allowlist 条目。过期的 allowlist 条目会使 guard 失败，因此退出是被强制执行的，而不是被记在心里的。

### 重复域

| 业务域 | 规则归属方 | Remote 面（`ctx.remote.*`） | API 代理 wire 面（`/api`） | 退出条件 |
|---|---|---|---|---|
| goals | `packages/goal/goal` —— Cordis `goals` 服务拥有 goal 阶段与 compare-and-set 规则 | 经 `rlh-goal/remote` 暴露的 `ctx.remote.goals.*`；消费方为 `packages/client/ui-goal` 与 web 客户端组装层 | `packages/host/apiproxy` 中的 `goal.create`/`edit`/`pause`/`resume`/`complete`/`clear`；产品客户端不调用它们——只有连接层测试 fixture 与 apiproxy 测试调用 | `RpcMethodMap` 不再声明 `goal.*` 键，且 [packages/host/apiproxy/src/api/goals.ts](../../packages/host/apiproxy/src/api/goals.ts) 被删除，同一变更中移除 guard 的 allowlist 条目 |
| skills | `packages/skill/skill`（registry）与 `packages/host/skill-inventory`（文件 CRUD）拥有目录；两个面都委托给它们 | 经 `rlh-host-skill-inventory/remote` 暴露的 `ctx.remote.skillInventory.*`；浏览器中的 `packages/client/ui-settings-skills` 经 loopback fence 消费 | `skill.list`，按会话读取的只读目录，由 `packages/client/ui-skill` 供输入框选择器消费 | `ui-skill` 改经 remote 面读取目录，然后从 `RpcMethodMap` 移除 `skill.list`，并删除 [packages/host/apiproxy/src/api/skills.ts](../../packages/host/apiproxy/src/api/skills.ts) |

### 浏览器信任 fence 的再暴露

`packages/client/connection/src/index.ts` 把 `PRIVILEGED_METHODS` 钉在 loopback，并把 remote 隧道组 `mcpServers/*`、`skillInventory/*`、`workResults/*` 再暴露给浏览器包（`ui-settings-mcp`、`ui-settings-skills` 与工作结果视图）。guard 钉住准确的方法清单，因此 fence 只能通过一次有意的清单变更收缩；不再使用 fence 的域必须离开钉住的清单。

### 新增重复

为 remote 组装层已挂载的域新增 API 代理处理器时，guard 会失败，直到 remote-wire 表与 allowlist 记录该决策，并在本文件或归属的迁移计划中补上状态行。

## Consequences

- 重复集合在一个 allowlist 中可评审，漂移使 `pnpm run test` 失败，而不是等待一次审计。
- 退出被机械强制：删除面却不退役其 allowlist 条目是测试失败；把方法留在 fence 上却不钉住同样是测试失败。
- remote-wire 表使未来的重复成为显式选择：新的 remote 贡献必须加入该表，从而迫使其归属方说明是否允许存在 API 代理对应物。
- guard 只读取源码文本，不新增构建步骤，也不改变运行时行为。
