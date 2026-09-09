# Agent Note：普通用户安全默认值

Status: implemented

[English](2026-08-29-ordinary-user-safe-defaults.md) | 中文

## 问题

已发布 profile 默认使用 `danger-full-access` 与 approval `never`，Desktop 新安装又默认关闭 Simple Mode。这些默认值与普通用户产品契约冲突，并把不受限开发者行为变成隐式选择。

## 决策

新的已发布 profile 默认解析为 `workspace-write` 与 approval `ask`。既有 `RLH_PERMISSION_MODE` override 仍具权威性；显式选择 `danger-full-access` 仍解析为 approval `never`，并展示为 `Developer Mode`。持久 permission setting 继续覆盖未来 Session 的 composition base，因此迁移会保留既有显式选择。

Desktop 新配置现在默认 `simpleMode: true`；持久化的显式 false 会一次性迁移到 Host 拥有的 `productMode` setting，并继续镜像给原生菜单过滤。Web 与 Desktop 使用同一 Web bundle 和同一持久 Client 投影。共享产品壳将顶层导航标记为 Chat、Work 与 Library；Work 组合既有 Session 投影，Library 打开既有 Files、Memory、Skills、MCP 与 Code Index 界面。

Simple Mode 会保留 Context Inspector provenance，而不是把来源透明度归类为高级诊断。Work 交付文件导航将来源 Session 与执行记录路径交给 [Host Work Results](../../../../packages/host/work-results/README.md) 权威处理，而不基于当前选中工作区解析路径。

Client 模式服务拥有 effect 生命周期失效标志，并在新派发或晚到发布前检查其捕获的所属 fiber。Owner 状态覆盖 effect 清理尚未执行的窗口；生命周期标志防止 fiber 重载后退役实例重新活跃。重读先等待本地已准入写入完成，再分配读取代次；与持久提交并发的 get 不能覆盖其已确认值。已经在途的 Host 写入不会被回滚，这一顺序也不会串行化其他客户端。

## 结果

普通 workspace 工作保持可写，不会持续弹确认。超出 workspace 的 escalation 使用既有 approval gate。完整 Host authority 以及模型、preset、plugin、trajectory 和 raw diagnostic 入口只在显式选择 Developer Mode 后出现；Context provenance 在两种模式中都保持可见。

## 备选方案

- 保留 unrestricted access 作为 fresh default——否决，因为它违反普通用户契约。
- 删除 full access——否决，因为 Developer Mode 仍是合法的显式工作流。
- 把 Simple Mode 仅作为 Desktop 菜单过滤——否决；共享 Host mode 现在拥有浏览器与 Desktop 呈现。
