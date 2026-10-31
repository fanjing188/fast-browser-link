# Testing

## Existing-page attachment

`existing_tab=true` 的离线回归位于现有 `test_open_tool.py`、`test_lifecycle.py`、`browser-consent.test.mjs`、`work-window.test.mjs` 与单工具/脚本适配测试。只接受当前页或唯一精确 URL，不接受模型指定任意 tabId；覆盖租约冲突、URL 变化、连接代次、原页操作与删除权分离。

真实 Chrome/Edge 验收只使用本地合成表单、临时 profile 和显式 scratch，不接触个人安装：

```sh
HERMES_SOURCE="$PWD/.ci/hermes" HERMES_PYTHON="$PWD/.ci/hermes/.venv/bin/python" node tests/native-v2/real-existing-tab.mjs
HERMES_SOURCE="$PWD/.ci/hermes" HERMES_PYTHON="$PWD/.ci/hermes/.venv/bin/python" node tests/native-v2/real-existing-tab.mjs --edge
```

先将 `TMPDIR` 指向私有 scratch。验收原页草稿/文档不变、不增加标签、同会话复用、跨会话拒绝、脚本可信点击与读页、关闭后保留原页/窗口/分组并恢复输入、重复 URL 拒绝。1440/375 截图与 `result.json` 写入 `$TMPDIR/existing-tab-{chrome,edge}/`。该 runner 为手动非离线门禁，不加入默认测试清单；本地夹具通过不证明真实账号业务已验。

## Login surfaces and OAuth popup acceptance

离线回归覆盖账号/密码/验证码用途、模态与固定浮层归属、Shadow DOM 和 iframe 边界、popup 发现与精确审批、操作权和删除权分离、公共结果脱敏及 Vault/script 绑定。

手动验收使用本地双来源和 Chrome/Edge 临时 profile，不复制个人登录态，不访问或登录真实 Google：

```sh
HERMES_SOURCE="$PWD/.ci/hermes" HERMES_PYTHON="$PWD/.ci/hermes/.venv/bin/python" node tests/complex-ui/real-login-windows.mjs
HERMES_SOURCE="$PWD/.ci/hermes" HERMES_PYTHON="$PWD/.ci/hermes/.venv/bin/python" node tests/complex-ui/real-login-windows.mjs --edge
```

运行前将 `TMPDIR` 指向私有 scratch。此 runner 使用 `compactScratch: true`，完整 socket 路径必须不超过 103 字节；不退回系统临时目录。JSON 结果与 1440/375 截图写入 `$TMPDIR/login-windows-{chrome,edge}/`。`--popup-only` 只复现独立小窗，不代表完整验收。

小窗创建入口置前以保留浏览器真实用户激活；批准接管后再最小化，验证账号填写、下一步和敏感字段识别。结束任务只撤销权限，原小窗保持存在。实际 Google 登录、验证码、验证器确认和站点风控需另行获准验收，本地通过不代表已登录真实账号。

## 1.4.4 bounded waits

当前源码：`wait_for` 通过一次 `page.observe` 请求在扩展内轮询，命中后一次局部解析；绝对截止覆盖 daemon 排队、扩展排队、探测及最终解析，落盘跨截止或迟到回执不得续派解析。每任务仅准入一个等待流程，排队前占位，超时后仍保留到队列与在途读取真实结算；这只终止本地等待，不证明底层 CDP 已取消。Python 条件传参断言在 `test_round1f.py`，五种条件、覆盖/文档终验、挂起/迟到/容量、接管/撤销断言在 `round1f.test.mjs`。开页摘要保留引擎 1400 预算整页及原游标，不再二次字符裁剪；片段按 `read_options` 原样续读，不重取首段。

离线测试 `tests/v1.4.4/test_round1f.py` 与 `round1f.test.mjs` 已纳入 npm 门禁；`replay-check.py` 只使用动作/错误码白名单和合成契约。

```bash
# 中文注释：手动夹具使用临时 profile；不属于离线入口。
node tests/v1.4.4/real-round1f.mjs
node tests/v1.4.4/real-round1f.mjs --edge
```

真实等待命中比较旧/新算法各五次，完整解析需减少至少 70%，p50 命中延迟不退步。机械基准仍需相同浏览器和起点 1.4.3，p50 退步不超过 10%。受限环境无法启动服务时，应记录阻塞并在可运行环境复查。

## 2.5.1 browser wake

离线浏览器唤醒回归在 `native-bridge/tests/test_browser_wake.py`、`executor-plugin/tests/test_open_tool.py` 与 `executor-plugin/tests/test_api_native.py`。测试使用临时账本和替身启动器，覆盖旧账本恢复、已知实例选择、同实例回连、并发合并、启动失败、超时、无效任务拒绝和不创建任务。实际 macOS 的 `open -g -b` 目标 bundle ID 已在本机安装包中读回；这些离线测试不证明个人浏览器在关闭状态下的真实重连，正式升级时不为测试而退出用户浏览器。

## 1.4.3 automatic cleanup

`npm test` includes `tests/v1.4.3/autoclose.test.mjs` and `tests/v1.4.3/test_autoclose.py`. They use synthetic browser APIs, temporary ledgers and the actual plugin hooks. Run the real fixture separately on your Mac:

```sh
node tests/v1.4.3/real-autoclose.mjs
node tests/v1.4.3/real-autoclose.mjs --edge
node tests/v1.4.3/real-autoclose.mjs --immediate
node tests/v1.4.3/real-autoclose.mjs --edge --immediate
```

The fixture uses a temporary profile and local server. Its completed hook runs in a short-lived Python process, followed by session finalize, while the daemon retains a three-second grace. It covers continuation cancelling grace, stop/interrupted/failed immediate closure, group renaming, `keep_tabs=true` page retention and an unchanged user-created group with the same title. It is not part of the offline runner. Mechanical navigation/click/fill p50 must remain within 110% of the same-browser baseline; use [the benchmark commands](bench.md).

## Self-contained tests

自动更新离线回归：`tests/auto-update/test_update.py` 验证正式版本筛选、摘要和 ZIP 安全、应用运行时延后、调度切换恢复、安装锁和状态隐私；`tests/v1.5.2/test_install_flow.py` 使用真实包与临时 HOME 验证完整升级、下载时应用重新启动、包损坏拒绝、启用失败回滚及后台不改写浏览器/剪贴板。网络及 launchctl 使用替身，这些测试不代表个人安装或真实后台调度验收。

Node.js 22.12+ and Python 3.11+ are sufficient. No Hermes install, browser, account or API key is required:

```sh
npm ci --ignore-scripts
npm test
npm run lint
npm run check:js
npm run check:docs
```

The core runner uses explicit Node and Python lists. Its React renderer uses this repository's locked development dependencies, not a personal Hermes checkout. Production plugins still use Hermes' React runtime. Core tests never launch browsers or register Native Messaging hosts.

## Full integration gate

`npm run verify` additionally imports the real Hermes plugin loader and tests API boundaries. It is intentionally separate from the core suite. Prepare an isolated test checkout, never overwrite your personal Hermes installation:

```sh
# 中文注释：使用固定 Hermes 提交，测试目录被 Git 忽略。
git clone --no-checkout https://github.com/NousResearch/hermes-agent.git .ci/hermes
git -C .ci/hermes checkout --detach e62a47ab680bf952b26559e540c28bc18571017c
uv sync --project .ci/hermes --frozen --no-dev --extra web --python 3.14
uv pip install --python .ci/hermes/.venv/bin/python PyYAML==6.0.3
HERMES_SOURCE="$PWD/.ci/hermes" HERMES_PYTHON="$PWD/.ci/hermes/.venv/bin/python" npm run verify
```

Use uv 0.11.2 for this recipe. The setup downloads upstream dependencies; the subsequent gate is offline. No provider credentials are needed. You may instead set `HERMES_SOURCE` and `HERMES_PYTHON` to an existing test installation. Browser Use CLI is only needed for real-browser official-tool acceptance, not for the offline suites; those use synthetic CLI fixtures.

The gate copies the working tree to a private scratch directory, runs every reviewed Node/Python suite, checks source drift, and writes `tests/v1.1-verification/latest.json` (ignored by Git). `.ci/`, build products and local evidence are excluded from the source snapshot. Existing `v1.1` runner names are retained as test-area names, not a claim that the current release is V1.1.

The lists are `NODE_TESTS`, `PYTHON_SUITES` and `REVIEWED_RUNNER_PATHS` in `scripts/verify-v1.1-offline.py`; `coverage-matrix.md` checks their inventory. A failing, zero-test, skipped or timed-out suite cannot turn the full gate green. Browser and installation runners remain opt-in.

## CI

- `checks.yml`: core tests, lint, syntax, documentation and package closure on Ubuntu and macOS, using Node 22 and Python 3.11; no credentials.
- `integration.yml`: manually dispatched macOS full gate against the pinned Hermes commit above. It uploads the gate report and never touches a personal installation.
- `secrets.yml`: a pinned Gitleaks binary checks the checked-out Git history; forks use read-only permissions. Public publishing still requires the separate clean-history checklist in [releasing.md](releasing.md).

To run a single suite:

```sh
node --test tests/v1.1-overlay/integration.test.mjs
python3 -m unittest discover -s native-bridge/tests -p 'test_tasks.py' -v
```

Set `TMPDIR` to a scratch directory; several tests create temporary homes and sockets there.

For private local acceptance, also set `FAST_BROWSER_VERIFY_SCRATCH` to that same explicit private directory. The full gate selects its snapshot root from this variable and then passes it as `TMPDIR` to child suites; setting only the caller's `TMPDIR` leaves the gate's default `/tmp` in effect. Keep the real `HOME`; do not change production socket paths or relax timing limits to accommodate a fixture.

### Adding tests

- Put tests next to the feature area (`tests/<area>/`, or the module's own test directory).
- Add every new offline test file to the explicit lists in `scripts/verify-v1.1-offline.py` and to `coverage-matrix.md`; `tests/v1.1-verification/test_gate.py` checks that they agree.
- Tests must write only to temporary directories, never into the repository.

## Real-browser tests

Real-browser runners (`real-*.mjs`, `*acceptance*.mjs`, `tests/v1-headed/`, `tests/v1.1-advanced/real-*.mjs`) launch Chrome or Edge with a fresh temporary profile, load the extension from source or a package, and drive real pages. They are opt-in and are never part of `npm test` or `npm run verify`.

Rules for any runner that launches a browser:

- Use a fresh `mkdtemp` profile and remove it afterwards. Never use or copy a personal profile, cookies or login data.
- Pass `--use-mock-keychain --password-store=basic`.
- **Keep the real `HOME`.** Only `HERMES_HOME` / `TMPDIR` may point to scratch. On macOS, a browser started with a scratch `HOME` has no keychain and Edge shows a "cannot find keychain" dialog — click *Cancel*, never *Reset to default*. `tests/v1-launch-safety` enforces this.
- Stage Native Messaging hosts only inside the temporary profile or an isolated home; never register them for your real browser.
- Terminate only the processes you started; do not use broad `pkill`.
- Write run outputs (JSON reports, screenshots) to ignored `evidence/` directories or scratch, not to tracked files.

`python3 tests/check-browser-launchers.py --strict` lists launchers in the repository and fails if a direct launcher lacks the mock-keychain flag.

Useful runners:

| Runner | Covers |
|---|---|
| `tests/native-v2/real-native-v2.mjs` | Full Hermes hook → daemon → extension chain on synthetic pages |
| `tests/native-extension/real-bridge.mjs` | Real Native Messaging framing, concurrent tasks, cross-browser |
| `tests/v1.1-advanced/real-matrix.mjs`, `real-controls.mjs`, `real-recovery.mjs`, `real-official.mjs` | Interaction matrix, controls, recovery, official-tool compatibility |
| `browser-workspaces/real-browser-acceptance.mjs` | Tab-group ownership and cleanup |
| `page-semantics/test.mjs`, `browser-interactions/test/acceptance.mjs` | Module behavior in a real Chromium page |

Run them one at a time and not beside another browser run. A passing historical run does not certify changed code — rerun what your change touches.

## Website-tool and network acceptance

`npm test` also checks `tests/site-tools/`, `tests/network-evidence/network.test.mjs` and generated API-reference drift. Run the packaged Chrome/Edge flow with `node tests/site-tools/real-sites.mjs --browser=all` using the same `HERMES_SOURCE` and `HERMES_PYTHON` test installation as the full gate. It uses temporary profiles, synthetic HttpOnly cookies and a local HTTP fixture. It does not verify third-party sites or modify a personal installation. Evidence is written under ignored `tests/site-tools/evidence/`.

The website-tool suite includes caught-error trials for unknown outcomes, pending approval and manual input. The packaged browser flow also checks capture continuity across navigation, successful cross-site snapshots, continued reads through an existing CDP session outside the initial origins and after returning, and a separately opened gateway. These assertions follow the cross-site policy introduced in 1.11.0; offline coverage in `tests/native-extension/core.test.mjs` checks that a snapshot after crossing sites succeeds while foreign-tab and stale-generation requests still fail. The packaged Chrome/Edge flow requires separate real-browser acceptance.

## Cookie mirror acceptance

The offline gate includes the Node and Python runners under `tests/v1.5.0/`. They use synthetic cookies and temporary state; they do not launch browsers.

Real login acceptance is opt-in and uses temporary profiles with a shared temporary daemon and a loopback fixture. Run manually on a machine with Chrome and Edge installed:

```sh
node tests/v1.5.0/real-cookie-mirror.mjs
```

Prefer `--headed` (and `--same-browser --headed` for two Chrome profiles): the confirmation panel opens only after the source window is verifiably focused, which headless browsers do not reliably report, so headless runs can fall back to the popup's pending-confirmation button or time out. The fixture issues randomized ordinary, httpOnly session and partitioned cookies; the runner checks source rejection, popup confirmation, import counts, readback and the target protected page, then scans every file in the temporary state (except the browser profiles' own cookie stores) and the session logs for the fixture values. `COOKIE_LEAK_SELFTEST=1` plants one value in the daemon directory and must make the run fail, proving the scan is effective. Missing partitioned-cookie support fails acceptance. Cookie values are never printed or saved. See [usage](design/usage.md#cookie-mirror) for limitations.

### Desktop Cookie mirror (1.5.1)

The offline gate includes `executor-plugin/desktop/cookie-mirror.test.mjs` and `tests/v1.5.1/test_desktop_cookie_mirror.py`. They verify real React/Query rendering and synthetic HTTP/runtime/daemon flows, including canary values in malformed inputs, bridge responses, errors and rendered HTML. The Python API runner needs the existing FastAPI, Pydantic and HTTPX test environment.

Manual acceptance uses the same temporary-profile launcher as 1.5.0. It sends HTTP requests through the real desktop API router via a TestClient fixture bound to the temporary profile, then performs a real click in the source extension confirmation panel and verifies the target's protected page. It does not launch the Hermes Desktop host; host rendering is covered separately by the offline desktop tests.

```sh
node tests/v1.5.1/real-desktop-cookie-mirror.mjs --headed
node tests/v1.5.1/real-desktop-cookie-mirror.mjs --headed --same-browser
COOKIE_LEAK_SELFTEST=1 node tests/v1.5.1/real-desktop-cookie-mirror.mjs --headed
```

Set `HERMES_PYTHON` to the existing test Python with FastAPI/HTTPX and Hermes dependencies when needed. The self-test deliberately plants a synthetic cookie value in the temporary daemon directory and must fail the leak scan. Both normal modes must pass without it. These scripts are never part of `npm test` or the offline gate.

### Installation flow (1.5.2)

`tests/v1.5.2/test_install_flow.py` runs in `npm test` and the offline gate using temporary HOME/HERMES_HOME, a verified package outside Git and command stubs. It covers first installation, repeat-install advice, source packaging, Release without Node.js, upgrade data/identity preservation, late corruption and activation rollback, uninstall/purge, deletion confirmation, dry-run without writes, prerequisites, profiles and read-only connection polling. No real installation or browser is operated. The reviewed baseline has 38 steps.

Manual acceptance still requires loading the printed extension path into a temporary Chrome/Edge profile, confirming doctor detects it, confirming browser connection authorization in the popup and checking restart behavior. Source tests do not replace that acceptance.

### Orphan overlay (1.5.3)

`tests/v1.5.3/overlay-orphan.test.mjs` is registered in the baseline Node gate. The baseline still has 39 steps and the known runner allowlist has 87 files.

Run the manual browser gate from the repository with an isolated test Hermes installation (never the live runtime):

```sh
HERMES_SOURCE="$PWD/.ci/hermes" HERMES_PYTHON="$PWD/.ci/hermes/.venv/bin/python" node tests/v1.5.3/real-overlay-orphan.mjs --headed
```

Use `--edge` for Edge. The script uses only temporary profiles and a temporary daemon. It checks debugger detach, extension reload, needs_sync after restarting that daemon, real page input after cleanup, and progress while a long action finishes. A machine that denies localhost/socket binding cannot complete this gate; offline DOM tests do not replace it.

### Background input and work windows (1.6.0)

At 1.6.0, the baseline gate had 40 steps and the known runner inventory had 89 files. These are historical counts, not the current gate declaration. `tests/v1.6.0/work-window.test.mjs` and `tests/v1.6.0/test_lifecycle.py` cover the window queue, unfocused creation/recreation, read-only behavior, raw CDP input routing, action effects, error projection, idle defaults, and empty-task reclamation.

Run `node tests/v1.6.0/real-background-input.mjs --headed` and repeat with `--edge`. The local fixture repeats each of five inputs three times in four window states, comparing DOM-synthetic input with CDP. Record the actual `document.visibilityState`; do not infer that an occluded window was reported hidden.

Run `node tests/v1.6.0/real-work-window.mjs --headed` and repeat with `--edge`. The temporary profiles verify three concurrent trusted clicks, unchanged user-window active tab/focus flags, background snapshot/coordinate input, minimized-window input, tool/script no-effect errors, session counts, and recreation after closure. `tests/native-v2/real-session.mjs` now also has a direct local-fixture smoke entry point.

To keep gate scratch files outside the user's Hermes directory, set `FAST_BROWSER_VERIFY_SCRATCH=/private/tmp/b16` together with `TMPDIR=/private/tmp` when running `npm run verify`. The existing gate still isolates HOME inside its scratch snapshot. No live browser profile or plugin installation is modified.

### Historical gate declaration (1.7.1)

1.7.1 时的 runner 声明为 44 baseline + 2 supplemental + 49 reviewed = 95 个步骤，known runner inventory 为 90 个文件。这是历史组成，不是当前门禁或全量通过声明；当前组成以 `scripts/verify-v1.1-offline.py` 和本次 `latest.json` 为准。

版本闭包定向测试只验证受影响的离线 suite；安装流程 suite 使用合成临时 HOME/HERMES_HOME。真实 Chrome/Edge、Hermes Desktop、安装升级和重启行为仍需单独人工验收，历史浏览器结果不能作为当前版本验收证据。

### 页面内容屏蔽候选

受影响的离线回归复用既有 `tests/popup-integration/content-filter.test.mjs`、`native-routing.test.mjs` 和 `popup.test.mjs`；此前未登记的 `native-routing.test.mjs` 已加入显式 Node 清单和 coverage matrix。内容、截图和回放用例通过真实 Executor→Bridge；配置用例通过实际 background 消息处理器。CDP、DOM、Canvas 是合成后端，不代表个人浏览器验收。完整配置、拒绝矩阵和个人验收要求见 [页面内容屏蔽](design/content-shield.md)。

## 执行底座与云端退役

SDK 和唯一脚本核心的验收合同见 [浏览器执行底座](browser-core.md)及[Python 执行核心](python-scripting.md#shared-execution-core)。定向入口复用 `tests/agent-link/test_agent_link.py`、`test_script.py` 与既有脚本/网站工具回归。

云端连接不进入新包和新安装。`tests/native-extension/cloud-link.test.mjs` 验证后台启动/重连不创建云 Native 通道；安装回归覆盖受管旧入口退役、遗留在途任务阻断与失败回滚，私有配对数据不清除。原云站点和云宿主测试随退役源码移除，不继续安装云端依赖。

CLI 源码通过、完整固定 Hermes 门禁、临时浏览器端到端及个人安装分别取得证据，不相互替代。

### Fast-Backlink 双扩展填写

`tests/native-v2/real-product-fill.mjs` 是手动 opt-in 的后台无头验收，复用临时 profile/Native stage 启动器，加载实际 Backlink 扩展；不调用其有头浏览器助手，不替换个人安装。先按本页准备固定 Hermes 环境，设置私有 `TMPDIR`、`BK_TEST_TMPDIR="$TMPDIR"`、`BK_PROTECT_REAL=1` 和 `FBL_BACKLINK_SOURCE=<Backlink源码绝对路径>`：

```sh
node tests/native-v2/real-product-fill.mjs --preflight
node tests/native-v2/real-product-fill.mjs --package --edge
node tests/native-v2/real-product-fill.mjs --package
```

预检不启动浏览器；后两条须串行运行。真实配对 UI、Port、Native 任务/双端租约、FBL 自有 isolated setter 与实际普通/AI 按钮接受本地合成资料及模拟模型服务；人工暂停、提交锁、未知写入不重放、通用 JS/CDP 拒绝与解除配对保留原页分别断言。结果和截图写入 `$TMPDIR/product-fill-{chrome,edge}-*/`，由主会话另行目视。脚本和语法通过不代表该端到端已通过，合成模型不证明真实供应商或账号业务。

### 当前页成品包导出

`tests/native-v2/real-page-export.mjs` 是手动 opt-in 的无头验收，复用同一临时 profile 和隔离 Native stage，固定实际打包代码，不操作个人安装。先准备本页的固定 Hermes 环境与私有 `TMPDIR`，串行运行：

```sh
node tests/native-v2/real-page-export.mjs --edge
node tests/native-v2/real-page-export.mjs
```

验收从本地合成页面的运行后 DOM 进入真实脚本/CDP helper，核 ZIP 的 CRC、成员路径、资源与覆盖清单、当前表单值清除及原页状态不变；离线预览核脚本不执行、没有向原站追加请求。输出写入 `$TMPDIR/page-export-{chrome,edge}-*/`。1440/375 截图须另行目视；脚本存在或语法通过不代表导出已通过，不证明整站、后端或原始框架源码可得。

## 2.1.0 无痕能力验收

`tests/native-v2/real-incognito-matrix.mjs --package --headed` 使用打包代码和临时 profile，覆盖 17 组操作；Edge 加 `--edge`。Chrome 可能出现系统保存框，需在测试任务建议的临时目录确认保存；不能用 DevTools 自动保存代替扩展下载归属验收。`--core-only` 用于单独检查非下载能力，报告明确标为 `core-without-downloads`，不能作为下载通过证据。输出位于忽略的 `tests/native-v2/evidence/`。

`real-login-continuity.mjs` 单独覆盖普通/无痕 Cookie 隔离及 A→B→C→A 的同任务身份、返回页新引用和展开后的统一日志；完整边界见 [无痕矩阵](incognito.md)。
