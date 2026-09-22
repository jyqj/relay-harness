# Agent Note: Execution relationship and recovery capability facts in passive Work views

Status: implemented

English | [中文](2026-09-20-execution-relationship-recovery-view.md)

## Problem

被动的 `inspect` Work 视图把执行列成一个平面集合。它记录了每个条目的驻留状态和粗粒度的 `recovery` 词，但读者既看不出每个执行与目标 Work 的关系——委派子执行、continuable 汇报者、fork 来源——也看不出恢复对每个条目能诚实承诺什么。更糟的是，没有任何机制区分图上的邻接与控制：一个冷的 continuable 子执行看起来存在关联，读者可能因此认定 Host 能对它执行操作，而实际上只有当前驻留才承载控制。

## Decision

[work-results](../../../../packages/host/work-results/README.md) inspect 视图中的每个 `WorkExecutionEntry` 现在携带两个可选事实，且只从既有所有者已发布的状态推导——持久化 Session 头、subagent 目录的描述符分类、进程内 Job 状态：

- `relationship` 命名指向目标 Work 的边。`owned` 标记 Work 自身的普通根或其启动的进程内 Job；`delegated` 标记 one-shot 目录子执行，以及根自身携带 `subagent` origin 头的 Work；`reports-to` 标记 continuable 子执行，它是唯一持有回到父执行的持久汇报通道的一类；`forked-from` 标记根由某个父 Session fork 而来的 Work。`controlLink` 是独立的控制观察：只有当 Host 注册表当前持有该执行时为真。邻接关系永远不会置位它。
- `recoveryCapabilities` 陈述恢复能诚实承诺的内容。`history` 取 `persisted`、`in-process` 或 `unknown`；`resume` 只在持久化 continuable 描述符或普通冷 Session 上为 `explicit`，对 one-shot 子执行与 Job 为 `unavailable`，无证据时保持 `unknown`；`control` 与驻留一致。未分类（损坏）的子执行整行报告 `unknown`，不作任何断言。推导只读描述符本身，从不查询激活租约存储，因此 `resume: 'explicit'` 承诺的是恢复路径存在，而不是租约当前空闲。外部一次性 provider 不发布 session 描述符，因此不产生条目，也不作任何承诺。

推导位于 `execution-facts.ts`；`work-view.ts` 只负责收集输入。紧凑的 `recovery` 字段取值与消费方保持不变。

## Alternatives considered

- 把控制建模为 relationship kind 的属性：这样 `delegated` 边会隐式宣称对存活子执行的控制，并否认对冷子执行的控制。把 `controlLink` 拆出来让两个事实各自独立为真。
- 查询激活租约存储以给出更强的 resume 结论：work-results 将依赖 subagent 包内部的租约机制，而且租约空闲也不等于 resume 获得授权（它还需要存活的父执行）。描述符才是持久化的能力证据；租约只解决并发接管。
- 把 fork origin 的后代 Session 也枚举为携带 `forked-from` 边的条目：现有目录只解释 `subagent` origin 头，枚举普通 fork 会让被动视图成为新的 session 图权威。fork 谱系保持为目标 Work 根自身头中的一个事实。
- 按条目编码为文字措辞（例如 "history only, not controllable"）：自由文本不利于本地化也无法测试；封闭取值集合表达同样的内容，UI 直接渲染它们。

## Consequences

Host 测试通过真实 HTTP `inspect` 端点，对存活根、冷的 fork/委派根，以及以持久化直接写入的 continuable、one-shot 和损坏子执行，验证 relationship 与 recovery 行；纯单元测试固定推导表。Product Shell 记录页在字段存在时渲染边类型与 resume 词，缺失时保持原样渲染。旧 `recovery` 字段的消费方不受影响。这个矩阵保持诚实的前提是输入保持诚实：未来目录新增条目种类或 Job 状态时，必须扩展 `execution-facts.ts`，而不是在消费端随意放宽视图。
