# Relay 文档地图

[English](README.md) | 中文

本目录描述 Relay 的**当前设计**，不保存完整调整历史。每个概念只设一个权威出处，其他文档以链接引用，不重复维护同一套规则。

## 阅读顺序

1. [`CONTEXT.md`](CONTEXT.md) — 产品定义、系统边界与术语
2. [`product/vision-and-positioning.md`](product/vision-and-positioning.md) — 定位、目标用户与价值主张
3. [`product/product-experience.md`](product/product-experience.md) — 傻瓜式体验、chat/work、Prompt Enhancing
4. [`feature-status.json`](feature-status.json) — 实现范围与证据引用，与实际执行的验证结果分开
5. [`repository-governance.md`](repository-governance.md) — GitHub workflow 权威、分支保护与外层容器/runtime root 分工
6. [`agent/overview.md`](agent/overview.md) — TypeScript Relay Harness 总体架构
7. [`agent/agent-runtime.md`](agent/agent-runtime.md) — Agent Loop、状态、恢复与本地验证
8. [`agent/work-and-files.md`](agent/work-and-files.md) — 无项目 work 与文件上下文
9. [`agent/memory.md`](agent/memory.md) — 已实现记忆治理与产品边界
10. [`agent/context-engine.md`](agent/context-engine.md) — 本地上下文引擎：多来源检索、Evidence 与打包
11. [`scheduling/interface.md`](scheduling/interface.md) — 尚未交付的外部中转调度接口

## 目录职责

| 目录 | 权威内容 |
|---|---|
| `adr/` | 当前仍具约束力的少量架构决策 |
| `product/` | 产品定位、体验、计费方向、路线图与风险 |
| `agent/` | agent 侧模块、契约和运行时设计 |
| `scheduling/` | 外部中转调度项目的定性需求、边界与接口 |
| `engineering/` | 当前 TypeScript 实现基线与工程验收标准 |

## 权威边界

- 本目录维护产品语义、系统边界、ADR 与机器可读功能状态。
- [`architecture.md`](architecture.md) 及 subsystem 目录维护当前实现的包、协议、事件与配置目录。
- `.github/` 只存在于仓库根；嵌套 `.github/` 会被治理验证器拒绝。
- 功能是否“已发布”不从路线图或 README 推断，只读取 [`feature-status.json`](feature-status.json)。

## 文档清单

### product/

- [`vision-and-positioning.md`](product/vision-and-positioning.md)
- [`product-experience.md`](product/product-experience.md)
- [`pricing-and-tiers.md`](product/pricing-and-tiers.md)
- [`roadmap.md`](product/roadmap.md)
- [`risk-register.md`](product/risk-register.md)

### agent/

- [`overview.md`](agent/overview.md)
- [`agent-runtime.md`](agent/agent-runtime.md)
- [`prompt-enhancing.md`](agent/prompt-enhancing.md)
- [`prompt-enhancing-context-pipeline.md`](agent/prompt-enhancing-context-pipeline.md)
- [`work-and-files.md`](agent/work-and-files.md)
- [`memory.md`](agent/memory.md)
- [`context-engine.md`](agent/context-engine.md)
- [`routing-signals.md`](agent/routing-signals.md)
- [`orchestration.md`](agent/orchestration.md)
- [`verification-and-effects.md`](agent/verification-and-effects.md)
- [`security-and-data-boundary.md`](agent/security-and-data-boundary.md)
- [`tools-and-skills.md`](agent/tools-and-skills.md)

### scheduling/

- [`overview.md`](scheduling/overview.md) — 外部调度侧需要提供什么，不规定其内部算法
- [`interface.md`](scheduling/interface.md) — HTTP/JSON + SSE 契约

### engineering/

- [`tech-stack.md`](engineering/tech-stack.md)
- [`p0-scope.md`](engineering/p0-scope.md)

## 维护规则

1. **当前态优先**：删除“此前、曾经、本次调整、退役”等迁移叙事。
2. **单一权威出处**：产品体验、运行时、记忆、调度接口分别由对应专篇维护。
3. **事实与设想分开**：未裁决项标为 `[待决策]`；待实验参数标为 `[待标定]`。
4. **调度边界**：本项目不设计中转调度内部算法，只定义需求和接口。
5. **变更纪律**：只有跨模块、长期稳定且存在真实取舍的决定才进入 ADR。
