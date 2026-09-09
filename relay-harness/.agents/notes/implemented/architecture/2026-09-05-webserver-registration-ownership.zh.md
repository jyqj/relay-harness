# Agent Note: Webserver 注册所有权

Status: implemented

[English](2026-09-05-webserver-registration-ownership.md) | 中文

## Problem

在预留路径上注册再释放只验证合成示例，不能判断真实插件卸载后是否遗留路由，还可能与合法路由冲突。陈旧 disposer 和重复 transform 函数需要注册项身份，而非 handler 身份。

## Decision

[Webserver](../../../../packages/host/webserver/README.md) 从唯一权威注册记录集合分派请求。每项包含捕获的路由或 handler、调用方 Fiber，以及由其 Cordis effect 拥有的激活生命周期标记。即使 Fiber 对象保留，卸载或重载该激活也会使标记退役。手动释放移除精确注册项并释放标记，disposer 幂等。

包私有实例状态使用稳定 symbol，使分别打包的服务与 invariant 入口读取同一组表。Invariant 等待拥有方完整卸载之后才检查残留的退役记录，不执行注册、请求或预留路径探针。异步 invariant 失败通过 logger 报告，不会逃逸为未处理的 Promise。

路由描述在注册时捕获。Index tap 按注册项删除，因此释放相同 transform 的最后一项不会删除第一项或改变中间 transform 的顺序。

## Alternatives considered

- **探测预留路径** —— 仅证明探针自身的 disposer，还可能干扰真实路由。
- **只比较 Fiber id** —— 同 Fiber 重载可以在 id 不变时结束一次激活。
- **在卸载通知时检查** —— 合法异步清理在完全结束前仍可能持有注册。
- **维护独立诊断路由投影** —— 重复权威状态，可能与请求分派漂移。

## Consequences

每项注册增加一个小型生命周期标记；正确 effect 释放同时移除路由和标记。Companion 能检测真实 exact、prefix、upgrade、fallback 与 transform 注册泄漏，而不成为路由拥有方。Loader HTTP 与原始 socket 测试覆盖优先级、变更隔离、异常收敛与关闭；生命周期测试覆盖真实泄漏、异步释放和同 Fiber 重载。本包生产源码不再依赖 webserver 豁免，即可满足逐文件覆盖率检查。
