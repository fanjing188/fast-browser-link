# Hermes Browser Link 1.11.2

2026-10-12。macOS 稳定版补丁。

## 改动

- **自定义下拉框选择**：对 ARIA combobox（自定义下拉框）执行 `ref_select_option` 时，先展开，再在最多 1.5 秒内等待异步挂载的选项；此前展开前就查找选项，选项晚于展开出现时报 `select_option_missing`。`by: "value"` 依次匹配选项的 `value` 属性与 `data-value`，`by: "label"` 不变。仍只在 `aria-controls`/`aria-owns` 关联的 listbox 内选择；多个匹配报 `select_option_ambiguous`，禁用项报 `select_option_disabled`，已派发结果未知时不重放。原生 `<select>` 行为不变。该问题自 1.10.x 即存在。
- **测试**：真实浏览器验收 `tests/native-v2/real-native-v2.mjs` 自 1.10.2 起卡在该下拉框步骤，后半段长期未执行。本版按 1.11.x 规则更新其中的旧断言（截图不再因 iframe 不可检查而拒绝、旧引用自动重定位、同一工作页允许跨站导航、未公开动作的错误码），每处注明依据；仍保留的保护对应断言未改。

其余行为与 1.11.1 相同。

## 安装

下载 `hermes-browser-link-1.11.2.zip`，解压后运行 `./install.sh`；已有安装运行 `./install.sh --upgrade`。更新后扩展会自动重载。仅在 macOS 上验证。

## 验证范围

- `npm test`：Node 939/939，Python 全部通过；`npm run verify`（完整离线门禁）`passed=True`。
- 真实浏览器（Chrome，临时 profile）：`real-native-v2` 自定义下拉框步骤及其后的截图、旧引用、导航、未公开动作断言通过；`real-recovery-1110` 8/8、`real-forms` 12/12、`real-login-windows` 29/29，`real-complex-ui`、`real-page-chains`、`real-tabs-interaction` 通过；`tests/parsing-port/real-s1-s4.mjs` 10/10。
- 已知未通过：`real-native-v2` 更后面的 browser-use CLI（browser-harness 0.1.8）`upload_file` 步骤报 `Could not find node with given id`（插件内部密码值扫描在共享 CDP 会话调用 `DOM.getDocument`，使外部节点 id 失效），本版未修复。
- 未验证：Windows/Linux。
