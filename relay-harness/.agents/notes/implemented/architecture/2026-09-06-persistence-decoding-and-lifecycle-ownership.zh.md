# Agent Note：持久化解码与生命周期所有权

Status: implemented

[English](2026-09-06-persistence-decoding-and-lifecycle-ownership.md) | 中文

## 问题

持久化协调器混合历史事件词汇、消息身份重建、写入调度和后端修复时，读者需要先理解无关策略才能找到活动状态所有者。若将其可变生命周期映射拆给独立 manager，fencing 与清理则会依赖额外同步。

## 决策

包私有的[存储事件规范化模块](../../../../packages/session/session-persistence/src/stored-events.ts)负责受支持的旧形状、确定性消息身份、依赖前缀的后缀分类，以及快照与接管语义。借用记录会被复制；独占的后端数组可以原地接管。变为不可变的是已标识消息，而非整个事件信封。

[协调器](../../../../packages/session/session-persistence/src/coordinator.ts)仍是逐 Session 操作链、活动绑定、准备、退休和最终变更证明的唯一所有者。JSONL 与 SQLite 适配器使用同一解码策略。规范化模块没有后端句柄、定时器、保留的 Session 映射或变更准入权。其函数不是新增的包公共导出。

## 验证

共享协调器与两种后端的契约测试覆盖恢复、后缀读取、不支持的词汇、退休，以及真实跨进程接管。直接所有权测试区分借用快照和独占数组接管，并验证已标识消息不可变。

## 曾考虑的替代方案

为原类增加 facade 仍会交错解码与生命周期策略。由独立 writer manager 持有另一份逐 Session 映射会增加同步义务。删除旧格式规范化会改变受支持的持久词汇，而非改善其局部性。

## 影响

事件词汇与持久化 API 保持不变。审阅解码不必追踪异步生命周期状态；生命周期变更仍只有一个串行化与 fencing 所有者。
