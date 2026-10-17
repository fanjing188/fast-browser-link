# Fast-browser-link 品牌

标志用光标连接独立的 agent 节点，表达由用户引导、在已登录浏览器中协作。几何图形为原创，不借用浏览器厂商标志。

48px及以上使用[标准SVG](../native-extension/brand-logo.svg)，16–32px使用[小尺寸SVG](../native-extension/brand-logo-small.svg)。小版按16单位网格绘制，去掉细连接线。最小尺寸16px，四周留出标志宽度四分之一的空间；浅/深工具栏均保留蓝色底块。[单色版](../native-extension/brand-mark.svg)移除底块，用同一高对比颜色绘制光标与节点。不得拉伸、旋转、加特效或并列调用方品牌。

唯一品牌主色为蓝色`#315fc7`，深色界面主按钮为`#99b6ff`；绿色、黄色、红色和灰色仍分别表示成功、等待、失败和未连接。图标底色在两个主题中均为蓝色。[brand.css](../native-extension/brand.css)统一中性色、状态色、10px容器圆角、7px控件圆角和系统字体，供弹窗、侧栏、悬浮球、执行浮层和结果页使用。明暗跟随系统，减少动态效果时关闭过渡与动画。

执行`python3 scripts/generate-brand.py`重新生成四档PNG；切换设计时替换标准与小尺寸SVG，或传入`--source`、`--small-source`和`--output`。生成器只使用Python标准库，仅接受明确填色的矩形和M/L/H/V/Z路径，遇到不支持的SVG立即报错。每轴四倍采样，不新增运行或开发依赖。影子层品牌模块从同一份CSS和SVG生成，不应单独修改生成结果。

品牌位置只显示Fast-browser-link名称与标志；调用方和模型标识可保留在运行详情。[弹窗与任务控制说明](popup-controls.zh-CN.md)记录授权边界。
