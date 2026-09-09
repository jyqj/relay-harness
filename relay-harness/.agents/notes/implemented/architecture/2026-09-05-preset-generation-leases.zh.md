# Agent Note: Preset 代际持有

Status: implemented

[English](2026-09-05-preset-generation-leases.md) | 中文

## Problem

组装编辑会创建新的常驻子树，但旧子树可能仍服务父 agent、继承的子 agent 与异步冷读取方。保留所有旧子树会泄漏活跃 watcher；替换缓存时立即释放则会破坏这些消费方。裸常驻 scope key 无法表达生命周期。

## Decision

[Agent Presets](../../../../packages/preset/agent-presets/README.md) 对每个代际的持有进行计数。Agent 加入时获取持有，由其上下文的 Cordis effect 负责释放。子 agent 继承父 agent 的精确代际，包括已被替代的代际。重新组装先获取替代代际，再移动父绑定并释放旧持有。缓存失效把代际标记为退役；只有退役且持有数为零的代际才释放 scope。每个 preset 保留一个当前缓存代际。

`acquireStandingScope()` 向冷读取方返回 key 与幂等异步 release。API Proxy 在历史呈现或异步技能列表读取期间保留句柄，并在 `finally` 释放，包括异常路径。冷读取方不再得到永久保留的裸 key。并发挂载仍保持 single-flight；失败清理只删除自身的缓存 Promise，不会擦除后继代际。

## Alternatives considered

- **只统计活跃 agent** —— 遗漏暂停在异步注册表操作中的冷读取方。
- **每次编辑立即释放** —— 使运行中的父子 agent 能力失效。
- **所有代际保留到进程退出** —— watcher 数量随编辑历史增长。

## Consequences

旧代际为实际消费方而非整个进程存活。永不释放的 agent 或读取方仍会保留其代际；显式所有权无法修复消费方泄漏。当前缓存代际的 watcher 保留到缓存失效或宿主退出。释放等待子树静止；清理错误会报告，但不会逆转已提交的重新绑定或编写操作。真实 Loader 测试验证真实文件系统 watcher 只在最后持有方退出后关闭、父退出后继承能力仍存在，以及重复冷读编辑循环只保留一个缓存代际。API Proxy 测试验证异步成功和失败期间均持有 lease。
