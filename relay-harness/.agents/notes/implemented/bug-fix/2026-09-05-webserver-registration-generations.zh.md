# Agent Note: Webserver 注册代次所有权

Status: implemented

[English](2026-09-05-webserver-registration-generations.md) | 中文

## Problem

HTTP、upgrade 或 fallback 的 disposer 会删除旧地址上的路由，即使该地址已有新的所有者。Index tap 的 disposer 也可能删除同一函数的后续注册。因此，重复调用旧 disposer 会移除属于其他注册实例的活动注册。

## Decision

每次注册返回仅执行一次的 disposer。执行清理前先将该注册实例退役，使重复或重入清理无法删除后继。路由清理保留注册时使用的键，而不是重新读取调用方的路由对象。

## Consequences

释放仍为同步操作，重复调用没有效果。请求路径与路由优先级不变。真实 Loader 组合测试覆盖 exact 与 prefix HTTP 响应、upgrade 所有权、fallback 响应，以及旧 disposer 执行后复用同一 transform 函数。五项回归在缺少实例所有权时均失败，修复后均通过。

## Alternatives considered

只比较 handler 或路由身份不足以保护后继，因为同一函数或路由对象可以再次注册。全局清理或拒绝复用地址只会破坏插件重载，而不是保障所有权。
