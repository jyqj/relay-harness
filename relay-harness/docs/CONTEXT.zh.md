# Relay 领域上下文

[English](CONTEXT.md) | 中文

> 本文是产品定义、系统边界和领域术语的权威入口。

## 产品定义

Relay 是一个**零学习成本、傻瓜式可用的通用 Agent**。用户只需要：

1. 用自然语言输入需求；
2. 需要时引入文件、文件夹或其他资料；
3. 查看结果，并只在高影响动作前作必要确认。

Relay 负责理解上下文、补全任务、调用工具、管理长任务、验证结果和组织交付。用户不需要先学习 Prompt 工程、创建项目、选择具体模型或理解 Agent 内部模块。

## 两种使用模式

| 模式 | 用户心智 | 系统行为 |
|---|---|---|
| **chat** | 直接对话 | 保持连续上下文，回答、解释或协助形成需求 |
| **work** | 把一件事交给 Relay 完成 | 建立一次独立任务，执行、验证、恢复并交付产物 |

work **没有 Project 前置概念**。一次 work 自带自己的目标、对话、文件上下文、运行状态和产物；用户可以在开始前或执行中引入文件。

## Prompt Enhancing

用户在输入框中写好草稿、尚未提交时，可以主动点击 **Enhance** 按钮。系统根据当前合理上下文生成更清晰、可执行的草稿并回填输入框：

- 不自动触发；
- 不自动提交；
- 用户可以继续编辑、撤销或直接提交；
- 不读取与当前请求无关的记忆和文件；
- 不替用户编造目标。

详细契约见 [`agent/prompt-enhancing.md`](agent/prompt-enhancing.md)。

## 系统边界

### Agent 侧（本项目重点）

TypeScript 实现 Relay Harness（见 [ADR-0005](adr/0005-adopt-ts-harness-runtime.md)）直接位于[仓库根目录](../README.md)，负责：

- chat/work 会话与 Agent Loop；
- Prompt Enhancing 的上下文组织；
- Work、文件引入和产物管理；
- 计划、工具、Skills、Subagent；
- 本地状态、恢复、权限门和结果验证；
- 治理型长期记忆产品能力。

### 中转调度侧（外部项目）

负责模型分级、模型信息、成本信息、benchmark 信息、入口信号生成和具体模型选择。本项目只规定：

- agent 需要调度侧提供什么能力；
- chat/work/Subagent 如何提交请求；
- HTTP/JSON + SSE 接口；
- 用户可见的模型强度等级和计费信息如何回传。

本项目不规定调度侧的评分公式、权重、模型池实现或运营策略。

## 设计原则

1. **用户说人话，系统补结构**。
2. **默认路径最简单，高级能力渐进展开**。
3. **Work 是任务，不是项目容器**。
4. **文件是显式上下文，不是隐式全盘扫描**。
5. **工具执行成功不等于任务完成，本地验证后才能交付**。
6. **状态外置、任务可恢复**。
7. **模型路由属于调度侧，agent 不参与训练或路由优化**。
8. **高影响动作可确认、可审计，能撤销的优先可撤销**。

## 术语表

| 术语 | 定义 |
|---|---|
| chat | 连续对话模式，不进入完整的执行型 Agent Loop |
| work | 一次可执行、可恢复、可交付的独立任务；不要求创建项目 |
| Prompt Enhancing | 用户提交前主动调用的草稿优化能力 |
| Work Context | 当前 work 的目标、对话、文件清单、状态与产物 |
| File Context | 用户显式引入当前 chat 或 work 的文件、文件夹及其元数据、摘要和访问边界 |
| Long-term Memory | 经过治理、跨会话保留的用户信息与偏好 |
| Agent Loop | 理解 → 计划 → 行动 → 观察 → 本地验证 → 交付/恢复 |
| Subagent | 主 Agent 为独立子任务创建的受限执行单元 |
| Routing Signal | `task_type + emphasis weights + difficulty + confidence + source` |
| 模型强度等级 | 用户可见的模型能力与价格梯度；具体模型名仍由调度侧管理 |
| 中转调度侧 | 独立项目；根据信号、模型能力、benchmark、成本和后台策略选择模型 |
| 本地验证 | Agent Loop 内用于确认任务结果的保底机制，不上传、不训练、不参与路由 |

## 当前阶段

运行时是 [ADR-0005](adr/0005-adopt-ts-harness-runtime.md) 定义的根目录 TypeScript Harness。默认 composition 已交付 Agent Loop、恢复、工具、Subagent、Chat/Work/Library 产品壳、显式 Prompt Enhancement、本地 Context Engine、治理型 Memory、Code Index、MCP/Skills 目录，以及普通用户安全默认权限。

当前未交付的 Relay 专属能力是外部中转调度客户端、用户可见的模型强度与计费契约。功能状态不在本文重复维护；以机器可读 [`feature-status.json`](feature-status.json) 及其 CI 证据门禁为唯一权威。
