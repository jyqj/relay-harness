# Agent Note：work-inventory 浏览器 e2e 与已发布的框架与记录契约对齐

Status: implemented

[English](2026-09-20-work-inventory-e2e-product-alignment.md) | 中文

## 问题

`apps/web/tests/work-inventory.e2e.ts` 有两条断言在任何已发布构建上都无法满足，而被测的产品行为本身是正确的，并各有单元契约独立锚定：

1. **"uses the main area…"** 在 `data-surfaces-collapsed` 消失后立刻对 `AppFrame` 元素做一次 `getComputedStyle(gridTemplateColumns)` 读取。该属性反映布局 store 的 React 状态，是同步翻转的；但 `.frame` 按 300 ms 收缩曲线（`AppFrame.module.css`）对 `grid-template-columns` 做过渡动画，单次读取采样到起始值 `0px`，于是每次运行都以 "expected 0 to be greater than 0" 失败。
2. **"queries and pages cross-session outputs…"** 等待 `getByRole('heading', { name: 'Source record', exact: true })`。记录页把标题文案（`record.title`）渲染为页眉 eyebrow `<p>`，把被查看的会话 id 渲染为唯一的 `<h2>`（`RecordPage.tsx`）；产品中不存在任何名为 "Source record" 的 heading，因此即使记录路由、被动读取、marker 文本与 URL hash 全部正确，该等待仍然超时。

## 决策

- inspector 断言改为轮询计算后的轨道宽度直至动画完成（`expect.poll(..., { timeout: 15_000 }).toBeGreaterThan(0)`）。原始意图保留——必须是真实框架而非 mock 的布局回调分配出打开的 inspector——同时容忍已发布的收缩动画；从不分配的框架仍会让轮询失败。
- 记录页等待改为 `getByRole('heading', { name: OTHER_ID })`（打开时与 reload 后各一次）。按 `RecordPage.tsx` 与 `record.client.spec.tsx` 的契约，heading 就是所选来源的会话 id，且单元测试锚定了"heading 显示当前路由的来源、绝不停留在旧值"。按 id 匹配因此严格强于匹配静态页标题：它证明打开的正是这个来源，即该测试宣称的目标（"preserves the selected source on open"）。

产品组件刻意未改：eyebrow 加会话 id 的页眉结构与 300 ms 网格动画都是已发布契约，各自有单元测试或文档化的 CSS 行为锚定。这份 e2e 文件与组件出自同一个恢复树提交，却编码了产品从未有过的 DOM 与时序；缺陷在 e2e 的定位器，而不在最初怀疑的失效（invalidation）或 openHistory 语义。在 P12 精确 Library 失效与 P06 只读 `openHistory` 就位的情况下，整个文件现在 5/5 通过，其中包括端到端演练精确失效的冷确认用例。

## 后果

- CI 的 web lane 重新获得真实信号：两条失败场景现在断言产品真正拥有的分配与来源身份。
- 未来改动收缩动画或记录页页眉结构的工作，必须连同 `AppFrame.module.css` / `RecordPage.tsx` 一起更新这些断言；定位器是语义化的（role 加路由身份），不锚定 CSS。
- 无产品代码、README 或 locale 变更；不影响任何 snapshot golden。
