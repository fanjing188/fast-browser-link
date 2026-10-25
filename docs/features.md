# Features and limits

This catalog describes the current source feature set. See the [changelog](../CHANGELOG.md) for published versions. Local/offline checks, isolated browser checks, installed runtime checks and GitHub publication are distinct evidence states. Current acceptance commands and limits are in [testing](testing.md).

See the [origin-list contract](design/protocol.md#origin-list-contract) for `allowedOrigins`, including network evidence: new HTTP(S) request origins are recorded, not rejected against the initial list; child frame sessions are excluded.

## Capabilities

| Area | What is supported | Limits |
|---|---|---|
| Connection | Existing Chrome/Edge instances over Native Messaging; several browsers at once | Does not start browsers or copy profiles. Task isolation is not cookie or account isolation. |
| Connection authorization | Confirm in the extension once, then ordinary task-page actions execute directly; no smart-approval switch or repeated ordinary prompts | Does not authorize existing personal tabs. Takeover/resume/stop, credential protection and the Cookie mirror confirmation remain independent. |
| OAuth login windows | Discover a newly opened existing login window via `popup_catalog`, then explicitly adopt its exact candidate with `popup_adopt` | Login windows are adopted directly without confirmation, including candidates outside the provider allowlist. Adoption grants operation and target origins, not deletion rights; the original login window is retained when the task ends. |
| Tasks and tabs | Since 1.11.0, task pages can navigate across sites and agents can read and operate the cross-site content; per-task tab groups, exclusive tab leases, resume with a new generation, cleanup of task-created tabs only | Task/session identity, generations and tab leases remain checked. `allowedOrigins` is dynamic origin metadata, not a fixed site allowlist. Sensitive fields still use the user or Vault. Tabs you move out of the group or whose ownership is unclear are left alone. |
| Page reading | Semantic snapshots with bounded region/record context and compact text trees, control states, slot labels, virtual table indices, filtering, paging and deltas | Browser connection authorization permits ordinary reads directly, including the first site read; no per-action confirmation. Tabs list only that task's leased tabs. Not a full accessibility tree. Explicit scoped AX supplementation is capped at 16 non-value-bearing controls; partial coverage is disclosed. Automatic shielding also applies to read results. |
| Targets | Open/closed Shadow DOM, including closed components inside same-origin iframes; task-verified cross-origin (OOPIF) frames, including origins outside the initial list via `frame_catalog` tokens | Closed roots require confirmed CDP node access and are capped at 200. Unreadable child frames do not block parent DOM reads; rotated or skewed frames are rejected for actions. |
| Actions | Confirmed reference clicks (trusted when visible, synthetic when hidden), fill, bounded key presses, checkboxes/radios/switches, native single/multi-select and ARIA single-select controls, scrolling (page or a specific container), back | Each action rechecks visibility, occlusion, stability and staleness before dispatch; nothing is retried after dispatch. |
| Screenshot-bound interactions | Capture, element bounds, coordinate click, pointer drag and HTML5-synthetic drag | Coordinates are raw PNG pixels from the same capture. Hidden coordinate clicks use confirmed DOM events; hidden pointer drags are rejected. Synthetic HTML5 drags report `isTrusted: false`. |
| Python scripts | `fast_browser_script` with page, file, download and page-execution helpers; request ledger, reconnect and explicit checkpoints | Each run is a new process running as your user — not an OS sandbox. A crashed script's Python state is not restored. |
| Current-page frontend ZIP | `export_page` saves rendered top-level HTML, readable cached frontend resources and a hashed coverage manifest through the existing script/CDP chain | Always partial, no crawling, backend or original framework source. Preview disables scripts/forms/external loads and clears current form values; raw JS and visible content may still contain private data. See [export contract](python-scripting.md#current-page-frontend-export). |
| Page execution | Page JavaScript (isolated or main world), raw CDP, CDP event reads, `browser_exec` gateway | After browser connection authorization, execution runs directly without per-action prompts. Existing gateway sessions remain usable across sites and after returning to the initial origin. CDP events include other frame origins, while credential headers and Bearer values are removed. Credential fill and scripts cannot share a page. With shielding enabled, unsupported raw CDP/event, console, image-list and network-inspection outputs are refused. |
| Uploads | Local paths named in conversation, copied into task-private storage, selected into a visible file input in the main document | Up to 10 files, 100 MiB each. Hidden inputs and inputs inside frames are not supported. The OS file dialog is never driven. |
| Downloads | Attribution to the task, cancel, claim with size and digest verification | Ambiguous concurrent downloads are never claimed automatically. |
| Credentials | Optional takeover of unified `browser_vault` actions and legacy Hermes Vault tools: safe metadata list, unlock, login fill, TOTP entry and save login through a private local channel; supports the verified synchronous SDK contracts and restores originals on unload/failure | Off by default; also requires `tools.override`. Bound tasks never fall back to a different browser when binding/private transport fails. Source compatibility is tested with synthetic credentials, not a personal Vault. External password-manager CLIs must be installed and unlocked separately. Payment cards and addresses are not handled. |
| Official tools | 18 official Hermes browser tools and 28 `browser_exec` helpers, routed for bound sessions (see [usage](design/usage.md#fast-official-browser-tools)) | Version-dependent; use the generated capability reference for the connected instance. `browser_snapshot(full=true)` is not supported. |
| Visibility | Whole-task input overlay, status, takeover/stop, action highlights and an always-enabled task cursor with smooth travel | Cursor remains between steps, hides on takeover/disconnection or hidden tabs, respects reduced motion, and is hidden/restored for capture. |
| Diagnostics | Correlated, field-allowlisted events and the latest task steps on the webpage overlay | Never records page text, credentials or free-form exception text. |

## Not supported

- A standalone browser, headless mode or profile cloning.
- Automatically claiming popups or windows opened by page scripts.
- Restoring an arbitrary Python process after it exits (resumption is cooperative, through explicit checkpoints).
- Cross-origin, mutating, or `Authorization`/CSRF-protected API calls through `api_request`.
- A built-in credential store, a third-party site-adapter catalog or a persistent result center.

## Site tools, network evidence and page requests

Verified custom site-tool drafts, bounded network evidence, same-origin page requests, read-only doctor and generated capability-aware API reference are described by module in the [product catalog](design/product-modules.zh-CN.md). These tools reuse the existing task and script execution chain. Verified source does not mean a personal installation or public release has been updated.

## Page output and sensitive fields

Since 1.11.0 there is no content filtering, shielding switch or content-protection refusal: page text, attributes, script results and diagnostics are returned as-is. Password input values are replaced with `[password]` in every output.

Password, payment and one-time-code fields keep their protection. Semantic snapshots mark them with `fieldKind` and `inputRequired: vault_or_user` and expose no actions; `ref_fill`/`ref_press` on them return `user_input_required` so the user fills them (or Vault does). Screenshots still mask visible sensitive fields; when the mask cannot be confirmed they return `capture_sensitive_blocked` or `capture_frame_uninspectable`. See [page output and recovery](design/content-shield.md).

## Cookie mirror

Open **Hermes Desktop → 浏览器连接 → Cookie 镜像** to read/search the site inventory, select one or several sites, choose another connected browser/profile, and view transfer status and counts. The browser popup no longer displays Cookie mirror controls. The mirror dialog is centered on an opaque elevated surface with a scoped backdrop, fits narrow/short windows, and keeps native cancellation and focus behavior.

Each transfer requires a real click in the source extension confirmation panel, including full-access mode. Optional target-cookie clearing defaults off. Session cookies keep session lifetime unless persistence for 1–365 days is selected. Only the default non-incognito store is supported. Values travel once through bounded memory with a 60-second deadline including approval; disconnect/failure clears payloads. They do not enter task files, model responses or diagnostic logs.

Cookie copying does not copy localStorage, IndexedDB, device keys or MFA state, and readback identity matches do not prove login. Site grouping uses a small suffix table rather than a complete PSL. The public tool offers `list_sites`, `request_mirror`, and `status` with allowlisted metadata only. See [usage](design/usage.md#cookie-mirror) and [security](../SECURITY.md#cookie-mirror-150).

## Stable-release updates

The shared root contains one regular program directory at `plugins/fast-browser-link`; named profiles reference it with direct directory links. Profile enablement, optional capabilities, task identities and private data stay separate. Upgrade includes old copies and unrecorded entries without enabling disabled profiles. Transactional backups and Hermes Desktop's application-level UI cache remain outside the shared-program claim. Unknown links and linked data/ancestor paths are refused; link-creation failure never falls back to copying or privilege elevation.

After installing the maintenance component, use `./install.sh --check-update`, `--update`, or `--auto-update check|install|off`. Scheduled checks run hourly; automatic installation waits until Chrome, Edge and Hermes exit. GitHub asset digest, archive paths, complete package inventory, version and extension identity are checked before the existing backup/rollback transaction. Manual upgrade, update, uninstall and development sync share the installation and lifecycle guards. Active or unknown local/cloud work blocks replacement; the bridge exits after 30 seconds of verified safe idle, including completion of Cookie mirror cleanup.

Only stable releases qualify. GitHub pre-releases are skipped. Older updaters reject the shared package. Upgrade manually once, using `--upgrade --maintenance` when the old cloud launcher requires it; maintenance preserves pairing and restores the launcher on failure. The updater does not close applications or approve browser access, and the updated extension still needs reloading. See [installation](installation.md#automatic-updates--自动更新).
## 本机执行底座

浏览器执行通过本机 SDK、CLI、MCP 或 Hermes 适配器调用，不提供云端配对、中转或云端 Agent 连接。业务插件与执行器的边界见 [浏览器执行底座](browser-core.md)。旧安装的升级安全检查仍保护遗留在途任务、私有数据及回滚材料。
