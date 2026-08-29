# 外部中转调度接口

[English](README.md) | 中文

中转调度是独立项目。本目录只描述 agent 对它的定性需求、职责边界和版本化接口：

- [`overview.md`](overview.md)：需要调度侧提供什么能力；
- [`interface.md`](interface.md)：HTTP/JSON + SSE 契约。

本目录不定义调度侧的评分公式、benchmark 映射、成本权重、模型池实现和运营加权策略。
