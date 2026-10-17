# 协作扩展包

仓库仅内置中性通用包：Google 搜索、Google Trends、可见表格导出和关键词工作流。私人工具、凭据、团队规则与适配器放在仓库外的本机扩展包。扩展包不能授予浏览器权限，仍受工作区、租约、来源与后台静默守卫约束。

在本机协作 `config.json` 的 `extension_dirs` 中声明包的绝对目录。daemon 启动时显式读取，不自动发现、下载或执行包。无需改 Hermes 根配置；初始化保留已有配置与模板。升级后应审阅新合同并合并到本机模板，不能只替换前端。完整字段和协议参见[英文说明](copilot-packages.md)及[离线示例包](examples/copilot-package/package.json)。

```json
{"extension_dirs":["/absolute/path/copilot-packages/my-adapters"]}
```

每个目录放 `package.json`，`version:1`。后加载包覆盖前面的同名声明；`generic` 留给内置包。重复ID或不合法声明会阻止启动，不静默退回旧规则。

- `fetchers`：接口名对应 argv，不经 shell；以 `./` 开头的参数相对包目录解析。stdin 接收 JSON，stdout 输出模板 `output_schema` 规定的 JSON。凭据由本机脚本从环境或私有文件读取，不写入仓库、模板或日志。
- `pool.command`：stdin 接收 `keywords`、`csv_path`、`date`，**不添加任何固定命令参数**。回执为 `{"written":1,"skipped":[],"accepted_keywords":["sample"]}`。旧命令需本机包装器；未配置时不写入，显示缺回执，不能把退出0当作已新增。
- `pool.lookup_command`：只读，接收 `{"keyword":"sample"}`，返回 `{"found":true,"tier":"test","last_checked":"YYYY-MM-DD"}`，3秒超时。查池、查缓存、划词分类不调模型。
- `rules`：传给模型的判档规则JSON。内置规则没有固定量/KD门槛，阈值与意图指导在此配置；未知指标不能当零。
- `tools`：`id`、`hosts`、中英文 `name`、`links`（可带 `{keyword}`）。工具画像作为任务上下文，不会成为权限或自动打开的地址。
- `templates`：已有动作ID对应包内相对JSON路径，不允许越出包目录。保留宿主类型合同，用 `prompt` / `prompt_en`、schema和取数步骤声明能力；不能借此注入任意浏览器脚本。
- `workflows`：当前支持 `seo.ranking_sites:{seed_fetcher,site_fetcher,max_sites}`。默认一次SERP取数→前三个不同站点分别取数→一次合并判断；`max_sites` 为1–3。自定义接口保留标准SERP/竞品输出合同。
- `prompts`：可选 `{action:{en,zh}}` 本机提示词覆盖；只信任显式配置的本机声明，不把网页文字当提示词或授权。

声明生成器仅接收用户提供的源文件和目标目录，默认预览，不改协作或 Hermes 配置：

```sh
python3 scripts/setup-copilot-package.py --source /absolute/path/source/package.json --destination /absolute/path/copilot-packages/my-adapters
```

确认准备好后自行加 `--apply`。声明权限0600，不覆盖已有文件；引用的本机脚本和模板由用户放到目标目录。声明路径不代表脚本已存在或真实接口已验收。

趋势批量每图最多5词，分别打开美国/全球、近12月/5年后台工作页。只读取带明确日期与0–100数值的可见曲线表，不用SVG像素反推、不调用网页私有接口、不处理登录或验证码。页面未暴露可读表时显示缺曲线，不能宣称取得真实趋势。单批最多50词，整次后台取数最多10分钟；不同图独立归一化，不可当绝对需求量横比。

界面固定文案与模型提示按浏览器语言选中/英文，原文关键词和来源不翻译。划词窗随协作启停，可单独关闭；输入/编辑区、含密码的表单与工作页不显示。超过300字只留侧栏入口。7天内结果命中直接打开，不重取数；同词10分钟不重复触发推理。翻译/解释使用推理模型单轮且无工具；其他需要工具的通用任务继续遵守显式oneshot后备边界。

关联页面任务在工作页打开同一地址，保留地址中的筛选、排序和搜索参数及普通/无痕上下文；不复制表单值和页面内存筛选状态。界面提示后台筛选可能不同。不激活或修改用户标签页。

后台取数消息与判断上下文上限为128KiB；超限批次明确标缺，不截断或自动重试。需要时请缩小批次。

Google公开搜索后备也在一个取数任务中保留逐词SERP（最多50词、随机间隔，遇挑战即停止）；本机批量适配器可使用模板的1000词上限。
