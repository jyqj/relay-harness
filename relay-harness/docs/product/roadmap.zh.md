# 产品与工程路线图

[English](roadmap.md) | 中文

> 当前完成事实由 [`../feature-status.json`](../feature-status.json) 维护；本页只描述后续顺序，不重复伪造“已实现”清单。

## 已交付产品基线

Relay Harness 已提供普通用户安全默认值、Chat / Work / Library 产品壳、显式 Prompt Enhancement、本地 Context Engine、治理型 Memory、Code Index，以及 MCP/Skills 扩展目录。每项证据由 feature-status 门禁连接到默认 composition、Remote、UI、E2E 与文档。

## 下一阶段：Relay 专属路由

- 实现外部中转调度 HTTP/JSON + SSE 客户端；
- 固化 chat、work 与 Subagent 的 Routing Signal 契约；
- 提供用户可见的模型强度和计费说明，不暴露具体供应商路由细节；
- 用契约夹具覆盖正常流、断流、取消、超时与非法信号。

## 后续阶段：产品深化

- Work 与 Library 从紧凑侧边栏投影深化为独立中心栏路由；
- 文件引入、产物、审批、问题与恢复获得更完整的普通用户叙事；
- 多设备同步、团队协作和共享资料；
- 记忆导入、导出与多设备治理；
- 更多办公和专业 Skills、浏览器及第三方连接器。

## 阶段门

- 外部路由进入 `shipped` 前，必须同时具备默认 composition、Remote/API、UI、真实或契约 E2E 与文档证据。
- 新手用户验收必须证明默认 Simple mode 不要求理解模型、preset、插件、轨迹或原始日志。
- 未来布局变更必须保持根 workflow 发现、包路径、发布连续性与扁平 tracked tree 不变量。
