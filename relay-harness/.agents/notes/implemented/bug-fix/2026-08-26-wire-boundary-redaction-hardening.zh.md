# Agent Note: Wire 边界 redaction 加固

Status: implemented

[English](2026-08-26-wire-boundary-redaction-hardening.md) | 中文

## 问题

两条面向 wire 的路径会把承载 provider 或秘密内容的结果返回给客户端。`packages/settings/settings/src/redact.ts` 只遍历 `object`/`dict`/`array` 三种 schema 容器，其余节点的值原样返回，因此声明在 union、intersection 或 transform 内部的 `role('secret')` 字段会未经 redaction 跨越边界，且 `secrets` 记录为空——README 曾把这记录为 fail-open 缺口。另外 `packages/host/apiproxy/src/api-proxy.ts` 的 `session.search` 处理器把原始 provider 错误（`session search failed: ${String(error)}`）插值进 RPC 错误消息，把上游端点、查询文本或凭据片段带到 wire 上，且带有一个显式的 `XXX: Redact provider details before exposing this gateway` 标记。

## 决策

两条路径现在都 fail closed。`redactSecrets` 拒绝无法证明安全的 schema：walker 的 default 分支对 `dict`/`inner`/`list` 子关系做一次仅限 schema 的 `declaresSecret` 扫描，只能经由未遍历复合节点到达的 secret 将抛出错误（`refusing to redact a value whose schema declares a secret inside a <type> node at <path>`），而不是放出未 redaction 的值。未声明 secret 的 union 与 transform 原样通过；对缺失关系映射结构节点的容忍不变——没有关系映射的节点什么也不声明。

`session.search` 的 catch 先分类再开口。网关自构造的失败——工作预算、超页、游标重复三个守卫，现以 `SessionSearchGuardError` 抛出——消息保留在 wire 上，因为其中只有本 handler 度量出的计数与策略。类型化的 `SessionQueryError` 消息同样放行：该类是本仓库受控的 provider 词汇表（`SESSION_QUERY_*` 错误码），不是 provider 抛出的内容。其余错误皆由 provider 抛出、消息形状无界；它们落入 `ctx.logger.warn`（仅 Host 日志），wire 得到静态消息 `session search failed`。

## 已否决的替代方案

**按值深遍历 union 分支。** 一个 union 值只匹配一个分支，但不重新实现 schemastery 的解析就无法知道是哪个，猜错就会 redact 错路径。败给仅扫描 schema 的包含性检查——证明"不安全"不需要值级解析。

**在 wire 上对消息的个别字段做脱敏。** provider 错误的形状无界，任何字段清单都不完整。败给静态消息；完整细节保留在 Host 日志。

## 后果

把 secret 藏在 union、intersection 或 transform 里的 schema 现在会在调用点大声失败，而不是静默泄漏——在 wire 暴露的 namespace 上注册这种 schema，第一次 `describe({ redactSecrets: true })` 就会失败。此前"能用"这类 schema 的调用方本来就在泄漏，因此没有正确的调用方回归。仍开放的缺口是 `schema.toJSON()` 会把 secret 字段的 `.default(...)` 带给每个客户端；settings README 的 Known Limitations 条目保留该缺口与被推迟的 fail-closed `describeForWire()` 作为剩余工作。

## 测试

`packages/settings/settings/tests/redact.spec.ts` 新增三个用例：无 secret 的 union 原样通过、union 内的 secret 抛错、transform 内的 secret 抛错；既有容器用例不变。`packages/host/apiproxy/tests/api-proxy-search.spec.ts` 继续断言守卫消息（预算、页大小、游标重复）到达 wire，其 provider 失败用例改为断言静态消息——裸的 provider `Error('database unavailable')` 不再到达 wire。没有 e2e 或快照断言旧的插值消息文案。
