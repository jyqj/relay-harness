# Agent Note：异步 preset 读取持有确切代际与祖先链

Status: implemented

[English](2026-09-05-preset-read-scope-leases.md) | 中文

## Problem

冷读取租约能够保护常驻 effect，但技能目录等待 Provider 时，存活 Agent 的键仍可能被重新绑定。最后一个 Agent 释放持有后，也可能在读取完成前回收已退休代际。只持有代际不能冻结存活键的祖先链；改传常驻键则丢失 Agent 自有覆盖层与限制。

## Decision

`captureScopeReadView` 在不透明只读 token 后保存由原始注册身份组成的不可变祖先链。`scopeChainOf` 解析此链，`ScopedLayers.peek` 保留原始确切层。可变作用域创建、祖先绑定／重新绑定以及事件派发拒绝只读 token。视图只冻结祖先关系：注册表内容仍遵循自身 revision 规则，effect 仍受所有者生命周期约束。

`AgentPresets.acquireAgentScope` 同步持有已加入的代际并捕获完整 Agent 祖先链。网关将其用于存活历史与异步技能读取，并在 `finally` 中释放。冷读取继续使用 `acquireStandingScope`。重新组装不能让已有读取转向替代 preset；Agent 自有 effect 可按既有 revision 策略消失，但读取不会转向继任 Agent。[常驻挂载决策](2026-08-08-per-preset-standing-mounts.md)仍拥有组装与继承规则。

## Alternatives considered

**只持有代际但继续传存活键。** Provider 重试仍会遍历重新绑定后的父链。

**改传常驻键。** 这会丢失 Agent 自有注册层与确切作用域限制。

**克隆注册键或冻结注册表值。** 克隆身份看不到原注册；复制所有可变注册表会绕开它们自身的 revision 与生命周期规则。

## Consequences

不增加 Session 状态所有者或模型输入。独立测试覆盖重复加入失败不泄漏持有、冷读取持有期间删除、存活读取持有期间重新组装与 Agent 释放、确切层限制、拒绝用只读 token 变更／派发，以及异步技能读取成功和失败时的网关释放。资源所有权与不可变查找祖先链保持分离。
