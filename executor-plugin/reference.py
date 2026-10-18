"""中文注释：接口文档由实际 helper 和工具 schema 生成；在线查询按扩展能力裁剪。"""

import ast
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
FEATURES = {
    "network_start": "network_evidence_v1",
    "network_list": "network_evidence_v1",
    "network_detail": "network_evidence_v1",
    "network_stop": "network_evidence_v1",
    "page_request": "page_function_v1",
    "evaluate": "page_function_v1",
    "parse_page": "page_parse_v1",
    "extract": "page_parse_v1",
    "page_markdown": "page_parse_v1",
    "wait_for": "page_parse_v1",
}
SCHEMAS = {
    "fast_browser_reference": {
        "description": "查询实际 Python helper 签名。指定 instance_id 后按已连接扩展能力展示；未连接时不宣称浏览器接口可用。",
        "parameters": {
            "type": "object",
            "properties": {"instance_id": {"type": "string"}, "query": {"type": "string"}},
            "additionalProperties": False,
        },
    },
    "fast_browser_doctor": {
        "description": "只读检查插件安装、Native Messaging 注册、宿主和扩展连接，给出修复建议；不启动、重启或恢复授权。",
        "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
    },
}


def load(path):
    spec = importlib.util.spec_from_file_location("browser_reference_" + path.stem, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def helper_catalog():
    # 中文注释：从 HELPERS 真正导出的名字生成签名，不把私有函数误列为能力。
    tree = ast.parse((ROOT / "script_lane/child.py").read_text())
    exported = next(
        node
        for node in tree.body
        if isinstance(node, ast.Assign)
        and any(isinstance(t, ast.Name) and t.id == "HELPERS" for t in node.targets)
    )
    names = ast.literal_eval(exported.value.generators[0].iter)
    return [
        {
            "name": node.name,
            "signature": node.name + "(" + ast.unparse(node.args) + ")",
            "description": ast.get_docstring(node) or "",
            "requires": FEATURES.get(node.name, "browser_core_v1"),
        }
        for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name in names
    ]


def render():
    tools = {
        **load(ROOT / "native_tools.py").TOOL_SCHEMAS,
        "fast_browser_script": load(ROOT / "script_lane/tool.py").SCHEMA,
        "fast_browser_open": load(ROOT / "open_tool.py").SCHEMA,
        "fast_browser_use_tab": load(ROOT / "open_tool.py").USE_TAB_SCHEMA,
        **load(ROOT / "site_tools/tools.py").SCHEMAS,
        **SCHEMAS,
    }
    # 中文注释：生命周期约定与工具 schema 一起生成，API 参考检查也覆盖默认计时和移交语义。
    lines = [
        "# Generated browser API reference",
        "",
        "由 `python3 scripts/generate-browser-reference.py` 从实际 helper 和工具 schema 生成。不要手工编辑。",
        "",
        "## Page output and recovery",
        "",
        "页面内容原样返回，仅密码输入值不回显。coverage 表示未读范围。同一任务页可跨站；任务与会话标签租约仍隔离。定位失败插件已自动等待、重扫 frame/Shadow DOM 并最多恢复三轮。recovery 包含 triggered、rounds、locator、clickMethod、selected、otherCandidates；失败时另含 strategies、candidates 和 screenshotPath。仍失败就换描述重找或跳过该项继续，不停整个任务。已派发结果未知时先回读核实，不重复执行。",
        "",
        '动作 helper 可显式传 `after={"root":"#result","mode":"interactive","budget":3000}`；省略时回执保持原样。root 默认 body，mode 可为 interactive/content/table，budget 为 512–6000（默认 3000）。返回 observation 使用 semantic_snapshot 格式；失败只返回 observation.error，不改变 delivery/effect，也不重发动作。导航或文档替换后重新校验并生成 binding；旧引用不可沿用。',
        "",
        "## Task lifecycle",
        "",
        "每轮 `on_session_end(completed=True)` 默认立即关闭工作页；显式设置宽限时，同会话再次调用任意 `fast_browser_*` 取消计时。失败、中断和成功映射 owner 的 `agent_loop_stopped(session_key)` 立即按 handoff 结束。",
        "",
        "`FAST_BROWSER_IDLE_CLOSE_SECONDS` 设置完成宽限（0 为立即关闭）；`FAST_BROWSER_TASK_IDLE_TIMEOUT_SECONDS` 设置 ready 任务空闲上限（默认 1200 秒）。计时由常驻 daemon 管理并持久化，CLI 退出不丢失。",
        "",
        "暂停或仍等待人工批准/敏感填写的任务免于空闲扫描。`keep_tabs=true` 仅用于本轮回复明确请用户现在去该页完成验证码、登录、核验或最终提交，或用户明确要求保留；必须传 `handoff_reason`（captcha/login/verification/final_submit/user_requested）。遇阻、结果未知、读不到或被遮挡，记录 URL 和停点后普通关闭；任务结束撤权并收组，保留这些页面和用户页面。浏览器重启后无法验证的旧创建记录不授予清理权限。",
        "",
        "## Python helpers",
        "",
    ]
    for helper in helper_catalog():
        lines += [
            "### `" + helper["signature"] + "`",
            "",
            helper["description"].replace("\n", " "),
            "",
            "扩展能力：`" + helper["requires"] + "`。",
            "",
        ]
    lines += [
        "## CDP event pagination",
        "",
        '先用 `cdp("Network.enable")` 订阅，再从 `cursor=0` 开始读取；每次保存返回 cursor，hasMore=true 时继续。空批次不代表页面已停止产生事件。',
        "",
        "```python",
        "cursor = 0",
        "while True:",
        "    batch = cdp_events(max=500, cursor=cursor)",
        '    if batch["dropped"]:',
        '        raise RuntimeError("event gap: " + str(batch["lostRanges"]))',
        '    events = batch["events"]',
        '    cursor = batch["cursor"]',
        '    if not batch["hasMore"]:',
        "        break",
        "```",
        "",
        '游标日志按任务/标签页独立，序号单调递增，重复游标可重读保留区间；它与旧消费队列及网关推送互不消费。单页最多 500 条/256 KiB UTF-8，日志最多 10000 条/8 MiB，撤权或任务释放即清空，不落盘。过旧游标或单事件超过页字节限制时，dropped 为本次跨过的缺失事件数，lostRanges 的 from/to 是闭区间；不能宣称完整。requestState={state:"unknown",throughSequence:N,reason:"event_gap"} 将 N 之前开始且未实际收到终结的请求明确标为未知，不伪造 loadingFinished/loadingFailed。收到后续真实终结可以更新状态。',
        "",
        "省略 cursor 保持旧的 500 条消费队列：取走事件，溢出计数在读取后清零，新增 lostRanges 和未知状态标记。多次读取使用新 request_id；同一 RPC request_id 仍受既有去重账本约束。缓存读取在任务读屏障内独立于同页长命令锁，身份、租约、代次、来源、凭据页排斥及密码值过滤继续生效。凭据请求/响应头、Cookie 附带元数据和 Bearer 值在入队前剥离。",
        "",
        "## Diagnostic runtime",
        "",
        "health/browsers 使用运行时已解析的 bridge_home；doctor/reference 跟随同一个根，不重新选择安装。解析优先 FAST_BROWSER_BRIDGE_HOME，其次命名 profile 的共享根，最后当前运行时根。doctor/reference 的 runtime 显示 profileHome、bridgeHome、socket、tokenFile、pidFile（仅路径，不读出令牌内容）；doctor 的浏览器检查另列 manifestFile 和 launcher。命令行 doctor 不加载 Hermes .env，需继承相同环境；不猜测或切换另一套在线安装。插件安装检查仍针对 profile，连接检查针对 bridgeHome，不能把 plugin_missing 解释为扩展断连。",
        "",
        "## Tool schemas",
        "",
    ]
    # 中文注释：保留完整 JSON schema，避免手工参数表与注册接口漂移。
    for name, schema in tools.items():
        lines += [
            "### `" + name + "`",
            "",
            "```json",
            json.dumps(schema, ensure_ascii=False, indent=2),
            "```",
            "",
        ]
    return "\n".join(lines)


def project(browsers, instance_id, query=""):
    selected = next(
        (b for b in browsers if b.get("instanceId") == instance_id and b.get("connected") is True),
        None,
    )
    features = selected.get("features", []) if selected else []
    return {
        "connected": selected is not None,
        "features": features,
        "helpers": [
            h
            for h in helper_catalog()
            if h["requires"] in features
            and query.lower() in (h["name"] + " " + h["description"]).lower()
        ],
        "tools": list(SCHEMAS) + ["browser_site_search", "browser_site_manage", "browser_site_run"],
        "browsers": [
            {"instance_id": b.get("instanceId"), "features": b.get("features", [])}
            for b in browsers
            if b.get("connected") is True
        ],
        "note": "能力存在不代表已授权；页面调用仍检查任务和浏览器访问。",
    }


def register(ctx, runtime, home, *, lease_error):
    runtime.authority.lease_tools(tuple(SCHEMAS))

    def make_handler(name):
        def handler(args, *, session_id=None, **_):
            try:
                runtime.authority.consume(name, args, session_id=session_id)
            except lease_error:
                return json.dumps({"ok": False, "code": "session_identity_required"})
            if name == "fast_browser_doctor":
                path = ROOT / "native_bridge/doctor.py"
                if not path.is_file():
                    path = ROOT.parent / "native-bridge/doctor.py"
                return json.dumps(
                    load(path).diagnose(home, bridge_home=runtime.bridge_home), ensure_ascii=False
                )
            try:
                query = args.get("query", "")
                if not isinstance(query, str) or len(query) > 500:
                    return json.dumps({"ok": False, "code": "invalid_arguments"})
                # 中文注释：使用只读探针，不通过可能启动服务的常规 RPC 客户端。
                path = ROOT / "native_bridge/doctor.py"
                if not path.is_file():
                    path = ROOT.parent / "native-bridge/doctor.py"
                doctor = load(path)
                live = doctor.probe(runtime.bridge_home)
                result = project(live.get("browsers", []), args.get("instance_id"), query)
                result["runtime"] = {
                    "profileHome": str(Path(home).resolve()),
                    **doctor.runtime_paths(runtime.bridge_home),
                }
                result["probe"] = {
                    "ok": live.get("ok") is True,
                    "code": live.get("code", "connected" if live.get("ok") else "host_unconfirmed"),
                }
                return json.dumps(result, ensure_ascii=False)
            except (OSError, ValueError):
                return json.dumps({"ok": False, "code": "reference_unavailable"})

        return handler

    for name, schema in SCHEMAS.items():
        ctx.register_tool(
            name=name,
            toolset="fast-browser-link",
            schema=schema,
            handler=make_handler(name),
            description=schema["description"],
            emoji="🔎",
        )
