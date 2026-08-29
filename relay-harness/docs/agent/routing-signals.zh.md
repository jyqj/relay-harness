# Agent 侧路由信号

[English](routing-signals.md) | 中文

## 1. 边界

agent 只负责按调用场景提供内容、约束和已约定的路由信号。模型能力、benchmark、成本、运营权重和具体模型选择属于外部中转调度项目。

agent 不维护训练样本、路由遥测、分类器准确率或模型成本报表。

## 2. 信号结构

```yaml
routing_signal:
  task_type: string
  emphasis:
    <dimension>: number
  difficulty: trivial|easy|medium|hard|frontier
  confidence: number
  source: pre_classifier|parent_agent
```

约束：

- `emphasis` 是稀疏权重向量，权重之和为 `1.0`；
- 维度词表和版本由接口契约约定；
- `confidence` 范围为 `0..1`；
- `source` 不能由调用方任意伪造。

## 3. 信号来源

### Chat 请求与 Work 启动

每次 chat 请求和每次 work 启动时，agent 不提交已生成信号，只提交内容与约束，并声明 `signal_mode=pre_classify`。调度侧先调用自己的小模型生成信号，再按内部逻辑选模型。

### Subagent

主 Agent 创建 Subagent 时必须给出完整信号，并声明 `signal_mode=provided`、`source=parent_agent`。调度侧校验 Schema 后直接使用，不再调用小模型二次分类。

信号缺失、权重不合法或词表版本不兼容时，Subagent 请求失败并返回可行动错误，不静默猜测。

## 4. 与验证的关系

本地验证不属于路由信号。验证失败不会把结果发送给调度侧，不触发自动换模型，也不形成训练数据。

## 5. 接口

传输字段、SSE 事件和错误语义见 [`../scheduling/interface.md`](../scheduling/interface.md)。
