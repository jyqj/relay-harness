# @relay-harness/rlh-client-ui-memory-center

[English](README.md) | 中文

Web Settings 的 Memory Center。Client cache 按精确 Scope 与筛选条件缓存 list/search page，单独缓存详情，在 connection reset 时清空，并在每次治理 mutation 后使两类缓存失效。Cache generation 会阻止更早的在途读取在失效后重新写入旧状态。页面暴露所有 canonical status、query/status 筛选、分页、可见的 expiry/freshness、来源摘录、confidence/trust/importance、带 attribution 的 conflict 比较、带 historical/current revision 标签的跨 Session 已准入 why-used trace、canonical signal 与 outcome-backed ranking 详情。

candidate/disputed row 可以批准或拒绝。每次 mutation 都携带页面展示的 `revision`，因此过期 detail 不能覆盖更新的治理。非终态 row 可以修订 content、summary、importance、confidence 和 `validUntil`，也可以在填写必需原因后墓碑化。没有活动 Session 时全部读取与 mutation 都会被禁用，因为 Host 必须把用户治理事件持久化为 Evidence。UI 为了产品可理解性使用“删除”字样，同时明确说明 canonical 历史会作为 tombstone 保留。

## 模型体验

### 不直接发起模型请求

#### 模型看到什么

什么也看不到。本浏览器包既不组装也不发送模型请求；它只调用 `memoryCenter` 管理 Remote。

#### Token 影响

浏览器内为零 token。治理发生后，后续 `memory-agent` 请求可能准入不同的 Memory Context contribution。

#### KV Cache 影响

本包不会改变请求或 cache prefix。后续 recall 可能改变非 prefix 的 Memory Context message。

## 已知限制与暂缓事项

- Semantic conflict 以带 attribution 的 review candidate 展示；UI 不把 provider inference 呈现为 canonical truth。
- 单次详情 response 的 outcome history 限定为最近 50 条 observation。
