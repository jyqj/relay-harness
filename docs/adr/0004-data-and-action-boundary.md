# ADR-0004：显式文件上下文、最小权限和本地状态

- **状态**：已接受
- **日期**：2026-08-20

## Context

无项目 work 降低了用户心智，但不能演变为隐式扫描整台设备。普通用户需要简单的文件引入方式，同时必须知道 agent 能访问什么、会修改什么。

## Decision

1. chat/work 默认只能访问用户显式引入的文件、文件夹和本次产物目录。
2. 文件以 `File Context` 管理，记录来源、版本指纹、访问模式和处理状态。
3. 大文件按需读取、索引或摘要，不默认全文塞入模型上下文。
4. 写入、删除、外发和发布等高影响动作经过权限门；可撤销方案优先。
5. checkpoint、审计和验证证据默认仅本地保存，不作为平台遥测上传。
6. 敏感内容不得进入日志、错误消息或与任务无关的上下文。

## Consequences

- 产品界面必须持续展示当前 work 已引入的文件与授权范围。
- Prompt Enhancing 只能使用当前请求合理相关的上下文。
- 文件与安全细节分别见 [`../agent/work-and-files.md`](../agent/work-and-files.md) 和 [`../agent/security-and-data-boundary.md`](../agent/security-and-data-boundary.md)。
