# @relay-harness/rlh-client-ui-layout

[English](README.md) | 中文

布局插件拥有 AppFrame、主页面导航、面板几何和主题呈现。它注册到 `root` 并声明 `sidebar`、`shell.main`、`details`、`surfaces`、`shell.overlay`、`shell.titlebar.trailing` 和 `shell.terminalDrawer`。它的 MainContent 注册拥有 `conversation` 与 keyed `shell.page`；产品插件贡献页面，无需取得整个对话或 root。

## 主内容与检查区

主区域有持续挂载的对话，以及首次访问后保留挂载的页面。注册页面接收 `active`；隐藏容器使用原生 `hidden` 和 `display: none`，使控件不进入键盘焦点和无障碍查询，同时保留草稿和组件身份。取消注册会移除页面，未知选择回退到 conversation。`ctx.layout.mainNavigation` 是稳定 observable；`openMain(page)` 改变中央浏览状态，不选择 Session。显式导航关闭检查区和窄屏侧栏，并把焦点移入激活的主区域。导航不持久化，也不跨客户端同步。

Details 与 surfaces 按操作意图共用一个可见检查区位置：打开任一会关闭另一方，但保留它们的子树。AppFrame 使用列求解器的检查区优先策略。用户请求的检查区保持可见，中央区域先让出空间，在窄屏下可以把可用宽度全部让出。非优先的纯求解器仍提供固定中央最小宽度的让步策略。消费者以求解后的宽度而非偏好判断可见性；两种策略都不删除文件缓冲。

侧栏默认宽 280px，折叠后为 56px 控制栏。竖屏低于 768px 使用侧栏覆盖层和全屏工具详情；横屏依据真实设备旋转，而非键盘缩小后的视口。低于 1024px 隐藏标题栏尾部控件。显式主导航关闭窄屏侧栏覆盖层，使选中的内容可见。既有拖拽手柄、指针捕获和减少动画规则仍由 AppFrame 管理。

## 持久化与外壳层

Surfaces 和终端抽屉在 `rlhd.layout.panels` 保存开关状态与最近尺寸。侧栏和 details 是临时状态。切换不同的非空白 Session 会关闭 details，打开另一检查区也会关闭它。终端抽屉仍在中央列下方。主页面通过 subgrid 共享原标题栏行，并保留 48px 标题拖拽空间。

AppFrame 拥有标题拖拽带、标题栏尾部控件和可穿透点击的覆盖层。全屏模态项使用 `data-shell-modal-overlay` 标记根元素，以抬高覆盖层并禁用重叠的标题栏控件。尾部控件避让原生窗口按钮；被压缩的对话标题仍接收既有宽度预留和标签密度。Surfaces 跨越全部行，details 从标题栏下方开始。

主题呈现器应用已解析调色板变量、原生 `color-scheme`、深色状态和一个自有 `theme-color` 元素，销毁时撤销全局写入。浏览器入口导出插件加载值、`LayoutController` 和公开类型；实现组件与列求解器保留包内。

## 模型体验

无。布局状态、焦点和导航不进入模型请求。

#### KV Cache 影响

无；此包不组装或发送提供方请求。

## 已知限制与延期工作

- 主导航、侧栏尺寸和详情宽度是临时状态。刷新返回对话及默认侧栏；surfaces 与终端偏好持久化。
- 窄屏检查区可以占用中央区域。关闭它或显式选择主页面会恢复主内容。
- 布局变化不对重排文本做滚动锚定。此导航源不提供深链接或浏览器前进后退集成。
