# Agent Note：桌面偏好副作用与 smoke 隔离

Status: implemented

[English](2026-09-06-desktop-preference-effect-and-smoke-isolation.md) | 中文

## 问题

若不加区分地应用完整解析配置，保存无关偏好也可能修改系统登录注册。隔离的 smoke 配置仍与 Electron 应用共享系统登录项身份。草稿框可编辑也不证明已选中 Session，因此不能作为 Session 范围 Git 控件的就绪信号。

## 决策

配置 IPC 持久化规范化后的 patch，仅在 patch 显式包含 `openAtLogin` 时应用登录注册。`RLH_SMOKE=1` 在启动及配置写入时跳过系统登录同步，同时保留隔离配置的持久化。正常启动仍执行启动同步。

随包提供的工作区连接 walker 在添加 Workspace 后显式请求新 Session，使用指定工作区动作，或普通全局动作的最近 Workspace 回退。只有观察到选中的 Session 行和可用的输入框后，才声明工作区已连接。仅有可编辑的未发送草稿还不够。标题栏与 PTY 探针保留真实原生处理函数。

## 验证

IPC 回归区分主题写入、显式开启／关闭登录启动，以及 smoke 配置写入。源码与打包 smoke 入口驱动真实工作区选择器、Session 创建、标题栏命中目标、菜单和 PTY 回显，不提交模型生成请求，也不安装应用。

## 曾考虑的替代方案

忽略原生登录警告会保留无关系统变更。禁用 Git 断言会掩盖缺失的 Session 准备。仅为通过 smoke 而在生产中绕过 Git 的当前 Session 所有权，会引入另一份工作区权威。

## 影响

Smoke 不验证平台登录注册；IPC 单元测试验证委托与隔离。真实登录注册仍是独立的平台集成事项。普通产品的配置与 Session 所有权语义保持不变。
