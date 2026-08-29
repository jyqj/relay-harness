# Agent Note: API 包循环反转

Status: proposed

[English](2026-08-26-api-package-cycle-inversion.md) | 中文

## 问题

四个包构成依赖循环：`@relay-harness/rlh-api-remotes` peer 依赖 `@relay-harness/rlh-api-gateway`，后者的 client 半边注入 `@relay-harness/rlh-client-connection`，而 connection 从 `@relay-harness/rlh-host-apiproxy` 导入运行时值（`AbstractApiClient`、`toFetchHandler`），apiproxy 又在运行时导入 remotes。其中两条边看似"仅类型回边"，实为承重机制而非失误：`packages/api/remotes/src/client/index.ts` 里的 `export type {} from '…'` 语句把 owner 包的 client-safe 类型模块拉进消费方的编译 face，使 Cordis 声明合并（`TypertRemoteEvent`、`$on` 事件签名）得以生效；`rlh.client.inject` 清单则把 gateway 与 connection 组合进 remotes 的 client 装配——该文件自己的注释称这里是"两个平面 legitimately 相遇的唯一场所"。

这个循环构成债务的原因有三。按现状发布，四个包在 npm 上形成 peerDependency 循环，下游安装会触发 peer-resolution 告警。循环内任何包都无法按拓扑序重构、拆分或发布。而且 `api/remotes` 同时承担"生成契约镜像"与"运行时装配策略"两个角色，peer 依赖 22 个 host 包，导致每个 host 能力变更都穿越整条链。

## 方案

反转唯一方向真正错误的边——client 包从 `host-` 包导入运行时值——并拆分 remotes 的双重角色。`export type {}` face 组合机制原样保留：它是让声明合并对消费方可见的既文档化接缝，不是应删除的循环边。

**第 1 步——carrier 契约 leaf。** 把 wire 信封类型（`packages/host/apiproxy/src/api/rpc.ts` 中的 `RpcErrorDetailsMap`、`RpcError`、`RpcResult`）与 carrier handler 契约（`packages/client/connection/src/rpc.ts` 中的 `ConnectionRpcHandler` 系列、`apiproxy/client` 背后的 `IApiClient`）移入一个位于两组之下的 leaf 包（扩展 `rlh-typert-protocol` 或新增 `rlh-api-protocol`；两个候选都只依赖 `rlh-invariants`/`rlh-brand` 级 leaf）。`apiproxy` 与 `connection` 在迁移期从 leaf re-export，第 1 步不改变任何消费方导入。

**第 2 步——迁移 fetch handler。** `toFetchHandler` 与 `AbstractApiClient` 目前是 client 包从 host 包导入的运行时值。它们移入 leaf（或其旁的 `connection-transport` 包）；`apiproxy` 保留 RPC 分发并像其他实现方一样消费契约。第 1、2 步之后，`client/connection` 不再依赖任何 `rlh-host-*` 包，client face 约定（靠各 host 包手工维护"浏览器可用子路径"）获得结构性保证而非命名规则。

**第 3 步——拆分 remotes。** 把生成契约镜像（typert 生成的 remote faces、22-peer 类型面）与运行时装配策略（`rlh.client.inject` 组合）分开。契约镜像保留 peer 集合但成为无运行时导入的纯类型包；装配包保留注入清单并依赖 gateway/connection/leaf。拆分后 `gateway → connection → leaf ← apiproxy → remotes-contracts` 是 DAG，各部分按拓扑序发布。

## 已否决的替代方案

**删除 `export type {}` 语句以打断"类型回边"。** 它们承载声明合并副作用，删除会破坏消费方的 `$on` 类型（文件自身注释已记录）。否决——这是伪装成清理的回归。

**仅把 `RpcResult` 移入 leaf，`toFetchHandler` 留在 apiproxy。** 维持循环闭合的是运行时边而非类型边；仅移类型不减少任何 package 级 peer 循环，却搅动所有 `RpcResult` 导入方。否决，除非第 2 步同时纳入范围。

**保留循环，把它文档化为刻意的装配接缝。** 对单用户本地部署说得过去，但包一旦发布 peer 循环就在 npm 上暴露，而 22-peer 的 remotes 已经在给每次 host 变更加税。否决——在已发布表面缺陷上原地不动。

## 验收标准

`api/*`、`client/connection`、`host/apiproxy` 之上的 workspace peer 依赖图无环（可由 constraints 门禁检查证明）；`client/connection` 在两个 face 中都不导入任何 `rlh-host-*` 模块；`built-lib.e2e.ts` 实例化拆分后的装配并保持断言不变；两个 tsconfig 聚合构建且未新增逐文件特例。

## 风险

移动 `RpcErrorDetailsMap` 会改变声明合并扩展错误码表的位置，遗漏的合并面会在消费包里以类型错误显形，而不是在定义处——缓解方式是第 1 步与两个聚合的 `tsc -b` 及 apiproxy/connection/gateway 包测试同一次落地。remotes 拆分（第 3 步）触及生成代码与 typert 生成器的假设；若生成器硬编码了 remotes 包名，拆分要先改生成器。每一步都可独立交付，排序保证任何一步停滞时树保持绿色。
