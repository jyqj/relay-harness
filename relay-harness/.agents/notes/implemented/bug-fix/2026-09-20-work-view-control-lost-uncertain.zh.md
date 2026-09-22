# Agent Note: control-lost 作业在 WorkView 中报告为不确定，绝不报告为未运行

Status: implemented

[English](2026-09-20-work-view-control-lost-uncertain.md) | 中文

## 问题

WorkView 的执行连接（`@relay-harness/rlh-host-work-results`，`work-view.ts`）此前只把 `running`/`stopping` 状态的作业映射为"活跃"条目；其余所有作业状态——包括 `control-lost-unknown`——都渲染成 `activity: 'inactive'`、`recovery: 'history-only'`，并折叠为聚合值 `execution.activity: 'idle'`。作业契约的含义恰好相反：`control-lost-unknown` 表示有界停止在时限内未得到生产者确认，工作本身可能仍在运行，结果未知而非失败。阅读 Work 页面的用户可能据此断定后台工作已经停止——这正是引入 `control-lost-unknown` 状态所要防止的误读。

## 决策

- 作业状态既非活跃（`running`/`stopping`）也非生产者确认的终态（`completed`/`killed`/`failed`）——实际上就是 `control-lost-unknown`——的条目，使用现有词汇报告 `activity: 'unknown'` 和 `recovery: 'unknown'`，并且不带 `outcome`。详细的 `recoveryCapabilities` 保持不变：control 保持 `none`，条目绝不声称驻留。
- 聚合规则原本就会把任意 `unknown` 条目提升为聚合 `unknown`，因此只要存在 control-lost 条目，`execution.activity` 就报告 `'unknown'`。`WorkExecutionEntry.activity`、`WorkExecutionEntry.recovery`、`WorkView.execution.activity` 这几个联合类型都没有新增成员，因此逐字插值这些值的 type-equiv 文档和客户端都无需改动。
- `runningJobs` 确认阻塞条件仍然只统计 `running`/`stopping`。日志前缀确认陈述的是被审阅前缀的事实，与仍在运行的后台工作无关。

## Alternatives considered（已考虑的替代方案）

**新增一个独立的 `'uncertain'` 活动值。** 拒绝：封闭联合里已有的 `'unknown'` 表达的正是"不可观察、不可断言"，条目层和聚合层都是；新增成员会把同一语义拆成两套词汇，还要付出类型、文档和客户端的改动，却没有增加任何诚实度。

**把 control-lost 作业报告为 `running`。** 拒绝：这是反方向的正断言，注册表同样无法确认。诚实的取值就是未知。

**存在 control-lost 作业时同时阻塞确认。** 目前拒绝：确认记录的是被审阅的日志前缀，从不 imply 后台作业已经结束；在没有当前消费方提出需求前扩大阻塞集合会改变确认语义。

## 后果

- 存在 control-lost 后台作业的 Work 页面现在读取为 `unknown` 的 activity 与 recovery，聚合值为 `unknown`，取代了 `inactive`/`history-only` 和 `idle`；"未在运行"的误报消失。
- 由于联合类型未变，`docs/subsystems/work-results.md`/`.zh.md` 的 type-equiv 块保持不变；ui-product-shell 原样插值这些取值，因此没有新增 locale key。
- 想区分"空闲"与"不确定"的客户端现在必须诚实读取聚合值，而不是把一切非运行状态当作未运行；这是有意接受的成本。
- 回归覆盖：work-results host spec 启动一个永不 settle 的 owned 作业，通过有界停止把它驱动到 `control-lost-unknown`，并经由受信 HTTP remote 断言条目与聚合映射。
