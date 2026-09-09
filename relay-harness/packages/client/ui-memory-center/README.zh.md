# @relay-harness/rlh-client-ui-memory-center

[English](README.md) | 中文

Web Settings 的 Memory Center。公开浏览器入口仅将 `apply` 和 `inject` 作为值导出；缓存及字典命名空间保留在包内部。Client cache 按精确 Scope 与筛选条件缓存 list/search page，单独缓存详情，在 connection reset 时清空，并在每次治理 mutation 后使两类缓存失效。按请求键确认当前请求，可防止旧读取覆盖更新的刷新结果。失效会使全部在途请求失去缓存写入资格，而刷新单个键会保留其他作用域的缓存条目。页面暴露所有 canonical status、query/status 筛选、分页、可见的 expiry/freshness、来源摘录、confidence/trust/importance、带 attribution 的 conflict 比较、带 historical/current revision 标签的跨 Session 已准入 why-used trace、canonical signal 与 outcome-backed ranking 详情。

candidate/disputed row 可以批准或拒绝。每次 mutation 都携带页面展示的 `revision`，因此过期 detail 不能覆盖更新的治理。非终态 row 可以修订 content、summary、importance、confidence 和 `validUntil`，也可以在填写必需原因后墓碑化。没有活动 Session 时全部读取与 mutation 都会被禁用，因为 Host 必须把用户治理事件持久化为 Evidence。UI 为了产品可理解性使用“删除”字样，同时明确说明 canonical 历史会作为 tombstone 保留。

详情读取使用独立的选择代次。关闭加载中的详情会清除加载状态并使晚到响应失效；切换 Scope 也会如此处理。读取失败保留在当前详情弹窗中并提供明确重试入口；等待治理确认期间仍不允许关闭。同步适配器抛错与 Promise 拒绝都会被观察，且不推迟调用时机。

修订编辑器拒绝空白置信度，不再将其转换成零。非法数值范围或非未来有效期会显示校验消息且不发送修订；继续编辑会清除消息。显式零置信度仍有效，可选摘要/有效期留空时发送 null，并保留内容中的空白。

分页加载期间保留已有条目并禁用重复请求；加载失败时可从相同偏移量重试。筛选条件或作用域变化会使待处理的列表响应失效，旧页面不会替换或混入当前结果。

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
