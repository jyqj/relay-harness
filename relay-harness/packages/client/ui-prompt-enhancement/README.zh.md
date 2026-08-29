# @relay-harness/rlh-client-ui-prompt-enhancement

[English](README.md) | 中文

注册到 `conversation.input.right` 的 composer 控件。点击后，它以精确草稿和取消信号调用生成的 `promptEnhancement` Remote，把忙碌控件变成可访问的 Remote 取消操作，并打开带 assumptions 与 open questions 的原文/增强 diff。建议还会把 Context Engine 接纳的 Evidence 投影为文件、代码、Memory、History 或 MCP 来源行，展示资源 key、provider 自有的选择原因、新鲜度和验证状态；不会猜测未知或畸形的不透明 trace 条目。只有 Accept 才会替换值和单调 `draftRev` 都仍与尝试一致的草稿，从而阻止 ABA 编辑。替换使用普通输入事务，因此既有 composer 撤销和显式“撤销增强”操作都能在另一次 revision CAS 下恢复原文；Cancel、失败、Host 返回草稿不匹配、Session 切换／移除、卸载和陈旧结果都保留草稿，控件绝不提交。

## 模型体验

### 用户主动增强

#### 模型看到什么

控件发起 `promptEnhancement.enhance` Remote；Host 提供方拥有独立辅助请求与 trace 事实，浏览器 UI 状态、来源标签和文案不增加模型可见内容。该控件在 Simple 和 Developer 模式下都属于普通 composer。

#### Token 影响

控件本身增加零 Token。Host 提供方拥有辅助请求预算；接受建议后，只有用户提交才会增加主历史 Token。

#### KV Cache 影响

控件不改变主 Agent 请求或其可复用前缀。

## 已知限制与延后工作

- 建议对话框展示完整 removed/added 草稿 diff，而不是内联 word-level diff。
