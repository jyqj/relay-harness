# Agent Note: 显式上下文检索与只读工作检查

Status: implemented

[English](2026-09-19-explicit-context-passive-work.md) | 中文

## Problem

当前产品将执行激活与历史读取混合，并要求 provider 的整条消息适配其生产者没有遵循的预算。主动检索需要真实模型分派而非伪造用户输入；Work 与 Library 需要精确来源读取和诚实的部分覆盖。默认分支为 main，但部分继承的 workflow 仍指向 master。

## Decision

保留 Cordis、Agent 循环、Session 权威、provider 注册、已有子 Agent 租约与客户端对象投影。在现有 Context Engine 中增加明确 opt-in 的工具用途、独立候选批次、按来源累计预算和完整渲染计量。在 base/standard 装配 `retrieve_context`。代码、文件、当前会话历史、受治理记忆和精确 MCP 资源读取保留各自作用域，不创建第二个引擎或任务数据库。

提供只读 `workResults/inspect`、`history`、`review`。来源记录、普通 fork、委派、Goal 阶段、执行、缺失观察和确认范围保持区别。产品导航携带精确来源身份，并按路由与连接代次取消读取。现有活对话 API 继续用于交互动作。Library 复用现有 deliverables projection cache，保留有界语料观察，不再每页扫描全局修订。Workflow push 条件对齐 main，并保留嵌套项目清单。

## Alternatives considered

**新建 Work 数据库或通用命令总线。** 所需读取已有权威所有者。重复存储可写生命周期只会增加对账，并不能证明结果质量。

**把自动检索伪装成模型工具。** 只有服务方法并不够；新工具须经过真实装配、schema、分派和日志，并被下一次模型请求消费。

**跨领域全局原子快照。** Session、Goal、Job、provider 的独立时钟不能组成一个事务。响应改为明确记录来源切点与覆盖范围。

## Consequences

显式检索改变装配它的工具目录。整消息 provider 保持兼容，工具检索则必须明确支持。代码召回不会通过同名 cwd 服务不同执行文件系统。历史页只渲染有界最终文本，底层仍可能解码全部来源。Library 观察会过期，并报告省略或不可读来源，不宣称覆盖全部当前设备文件。

本次改动没有实现持久 Job 调度或强停对账、不可变输出字节库或文件内容验收、全局交互 Inbox、完整移除 API Proxy，或公网远程认证。既有日志前缀确认语义不变，不能把这些 RFC 条目误标为被新记录页或来源描述完成。

## Verification

引擎、provider 和工具聚焦测试覆盖预算、候选选择、作用域与取消。真实 AgentLoop 测试在本地索引上调用 `retrieve_context`，证明一条日志结果进入下一次请求且没有重复用户输入。可信 HTTP 测试覆盖冷历史只读查询、原有持久确认和 Library 分页观察。React 测试覆盖只读导航、旧页、隐藏读取、重连代次和失败。构建、生成 API、原生 lint、coverage 和组装浏览器结果分别记录在 PR 中；聚焦测试通过不等于全部门槛通过。
