// 中文注释：仅跟踪授权操作之后新建的登录窗口或标签；发现不授予页面或清理权限。
// core 提供任务/租约校验，审批前和确认后使用同一份脱敏身份快照。
const OBSERVATION_MS = 120000,
  CANDIDATE_MS = 600000,
  MAX_CANDIDATES = 32;
const denied = () => Object.assign(Error('POPUP_STALE'), { preDispatch: true });
const site = (url) => {
  const u = new URL(url);
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) throw denied();
  return u.origin;
};
const identity = (tab) => ({ tabId: tab.id, windowId: tab.windowId, origin: site(tab.url) });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
import { OAUTH_PROVIDERS } from '../page-semantics/oauth-providers.mjs';
export { OAUTH_PROVIDERS };
export function isOAuthProvider(url, providers = OAUTH_PROVIDERS) {
  try {
    const u = new URL(url);
    return (
      !u.username &&
      !u.password &&
      providers.some(
        (row) =>
          row.origin === u.origin &&
          (!row.paths ||
            row.paths.includes(u.pathname) ||
            (row.versioned && /^\/v\d+(?:\.\d+)?\/dialog\/oauth$/.test(u.pathname))),
      )
    );
  } catch {
    return false;
  }
}
export class OAuthPopups {
  constructor(executor) {
    this.executor = executor;
    this.observations = new Map();
    this.candidates = new Map();
  }
  invalidate(tabId, event) {
    const observation = this.observations.get(tabId);
    // 中文注释：导航撤销旧候选，但保留原操作的剩余观察期；替换对象使迟到的旧建页回读失效。
    if (event === 'navigated' && observation) this.observations.set(tabId, { ...observation });
    else this.observations.delete(tabId);
    for (const [ref, row] of this.candidates)
      if (row.source.tabId === tabId || (event === 'closed' && row.tabId === tabId))
        this.candidates.delete(ref);
  }
  current(source, candidateRef) {
    const row = this.candidates.get(candidateRef);
    if (
      !row ||
      row.expiresAt <= Date.now() ||
      !same(row.source, source) ||
      (this.executor.docs.get(source.tabId) || 0) !== source.documentGeneration
    )
      throw denied();
  }
  prune() {
    const now = Date.now();
    for (const [id, row] of this.observations)
      if (row.expiresAt <= now || row.task.revoked) this.observations.delete(id);
    for (const [ref, row] of this.candidates)
      if (row.expiresAt <= now || row.task.revoked) this.candidates.delete(ref);
  }
  async source(task, tabId, guard) {
    const tab = await this.executor.api.tabs.get(tabId).catch(() => {
      throw denied();
    });
    guard();
    if (
      !task.allowedOrigins.includes(site(tab.url)) ||
      (tab.pendingUrl && site(tab.pendingUrl) !== site(tab.url))
    )
      throw denied();
    return { ...identity(tab), documentGeneration: this.executor.docs.get(tabId) || 0 };
  }
  async arm(task, tabId, guard) {
    // 中文注释：缺少标签清单能力时不建立观察资格；附加发现逻辑不能阻断原有输入动作。
    if (typeof this.executor.api.tabs?.query !== 'function') {
      this.invalidate(tabId, 'unavailable');
      guard();
      return null;
    }
    this.prune();
    const source = await this.source(task, tabId, guard);
    const existing = await this.executor.api.tabs.query({});
    guard();
    this.observations.set(tabId, {
      task,
      generation: task.generation,
      modeGeneration: task.policy.modeGeneration,
      source,
      existingTabIds: new Set(existing.map((tab) => tab.id)),
      expiresAt: Date.now() + OBSERVATION_MS,
    });
    return source;
  }
  async recoverCreated(tab) {
    this.prune();
    if (
      !Number.isInteger(tab?.id) ||
      !Number.isInteger(tab.windowId) ||
      !this.observations.size ||
      !this.executor.api.tabs?.get
    )
      return false;
    // 中文注释：Edge 的 onCreated 可缺 opener；只补读本次新建页，不能借后来的观察认领旧页。
    const observations = new Map(this.observations);
    const fresh = await this.executor.api.tabs.get(tab.id).catch(() => null);
    if (!fresh || fresh.id !== tab.id || fresh.windowId !== tab.windowId) return false;
    return this.created(fresh, observations);
  }
  created(tab, observations = this.observations) {
    this.prune();
    const observation = observations.get(tab?.openerTabId);
    if (
      !observation ||
      this.observations.get(tab.openerTabId) !== observation ||
      observation.expiresAt <= Date.now() ||
      observation.task.revoked ||
      observation.task.generation !== observation.generation ||
      observation.task.policy.modeGeneration !== observation.modeGeneration ||
      this.executor.leases.get(tab.openerTabId) !== observation.task.id ||
      !Number.isInteger(tab.id) ||
      observation.existingTabIds.has(tab.id) ||
      tab.id === observation.source.tabId ||
      this.executor.leases.has(tab.id) ||
      [...this.candidates.values()].some((row) => row.tabId === tab.id)
    )
      return false;
    if (this.candidates.size >= MAX_CANDIDATES) return true;
    const candidateRef = crypto.randomUUID();
    this.candidates.set(candidateRef, {
      ...observation,
      candidateRef,
      tabId: tab.id,
      windowId: tab.windowId,
      expiresAt: Date.now() + CANDIDATE_MS,
    });
    return true;
  }
  async inspect(task, tabId, candidateRef, guard) {
    this.prune();
    const row = this.candidates.get(candidateRef);
    if (
      !row ||
      row.task !== task ||
      row.generation !== task.generation ||
      row.modeGeneration !== task.policy.modeGeneration ||
      row.source.tabId !== tabId ||
      this.executor.leases.has(row.tabId)
    )
      throw denied();
    const source = await this.source(task, tabId, guard);
    if (row.candidate && !same(source, row.source)) throw denied();
    row.source = source;
    const tab = await this.executor.api.tabs.get(row.tabId).catch(() => {
      throw denied();
    });
    guard();
    const window = await this.executor.api.windows.get(tab.windowId).catch(() => {
      throw denied();
    });
    guard();
    if (
      !!tab.incognito !== !!task.incognito ||
      !['popup', 'normal'].includes(window.type) ||
      tab.windowId !== row.windowId ||
      tab.openerTabId !== tabId ||
      this.executor.leases.has(tab.id) ||
      (tab.pendingUrl && site(tab.pendingUrl) !== site(tab.url))
    )
      throw denied();
    row.windowType = window.type;
    const candidate = {
      candidateRef,
      tabId: tab.id,
      windowId: tab.windowId,
      openerTabId: tab.openerTabId,
      origin: site(tab.url),
      windowType: window.type,
    };
    // 中文注释：查询窗口期间源页或 popup 可能已导航/移动；发布身份前再读回两端。
    const latestSource = await this.source(task, tabId, guard);
    const latestTarget = await this.executor.api.tabs.get(row.tabId).catch(() => {
      throw denied();
    });
    guard();
    if (
      !same(latestSource, source) ||
      !same(identity(latestTarget), identity(tab)) ||
      latestTarget.openerTabId !== tabId ||
      this.executor.leases.has(row.tabId) ||
      (latestTarget.pendingUrl && site(latestTarget.pendingUrl) !== candidate.origin)
    )
      throw denied();
    this.current(source, candidateRef);
    // 中文注释：候选可在有效期内完成导航；旧审批仍由 adoptPopup 的完整身份比较拒绝。
    row.candidate = candidate;
    return { source, candidate };
  }
  async catalog(task, p, guard) {
    await this.arm(task, p.tabId, guard);
    const candidates = [];
    for (const row of this.candidates.values())
      if (row.task === task && row.source.tabId === p.tabId) {
        try {
          candidates.push((await this.inspect(task, p.tabId, row.candidateRef, guard)).candidate);
        } catch (error) {
          guard();
          if (error?.message !== 'POPUP_STALE') throw error;
        }
      }
    guard();
    const adoptedPopupTabIds = [...(task.adoptedPopupTabs || [])].filter(
      (id) => task.popupSources?.get(id) === p.tabId && this.executor.leases.get(id) === task.id,
    );
    const adoptedPopups = [...(task.popupDiscoveries?.values() || [])]
      .filter((row) => row.adoption && adoptedPopupTabIds.includes(row.tabId))
      .map((row) => row.adoption);
    return {
      sourceTabId: p.tabId,
      observationMs: OBSERVATION_MS,
      candidates,
      adoptedPopupTabIds,
      adoptedPopups,
    };
  }
}

// 中文注释：只在本任务新文档开始时安装；密钥仅留闭包，页面不能通过公开 helper 切兼容模式。
export function installPopupGuard(secret, initialMode, config = {}) {
  const previous = window.open;
  try {
    const old = previous.__fblPopupGuard === true ? previous(secret) : null;
    if (typeof old === 'function' && old('status')?.version === 1) {
      old('mode', { mode: initialMode, epoch: config.epoch || 0 });
      return;
    }
  } catch {}
  const originalOpen = previous;
  const originalFocus = window.focus;
  const originalSubmit = globalThis.HTMLFormElement.prototype.submit;
  let mode = initialMode,
    armed = null,
    paused = false,
    reason = null,
    requests = [],
    epoch = config.epoch || 0;
  const emit = typeof globalThis[config.binding] === 'function' ? globalThis[config.binding] : null;
  const pause = (code) => {
    paused = true;
    reason = code;
    try {
      emit?.(JSON.stringify({ epoch, reason: code }));
    } catch {}
  };
  const request = (url, target, features) => {
    if (requests.length >= 1) {
      pause('capacity');
      return null;
    }
    let address;
    try {
      if (typeof url !== 'string' || !url || url.length > 4096) throw Error();
      address = new URL(url, location.href);
      if (!['https:', 'http:'].includes(address.protocol) || address.username || address.password)
        throw Error();
    } catch {
      pause('unsupported_url');
      return null;
    }
    if (address.origin !== location.origin) {
      pause('cross_origin_requires_confirmation');
      return null;
    }
    // 仅接管无歧义的逗号分隔声明；冲突、否定或不支持的写法保留给用户选择兼容。
    const flags =
      typeof features === 'string'
        ? features
            .toLowerCase()
            .split(',')
            .map((x) => x.trim())
        : [];
    const relationships = flags.filter((x) => /^(noopener|noreferrer)\b/.test(x));
    const detached =
      relationships.length > 0 &&
      relationships.every((x) => /^(noopener|noreferrer)(?:=(?:1|yes|true))?$/.test(x));
    if (mode !== 'background' || !armed || !detached || (target && target !== '_blank')) {
      pause(
        !armed
          ? 'outside_action'
          : mode === 'strict'
            ? 'strict_mode'
            : 'window_relationship_required',
      );
      return null;
    }
    requests.push({ url: address.href, nonce: armed });
    return null; // noopener/noreferrer 的原生返回值也是 null，不伪造 WindowProxy。
  };
  const control = (op, value) => {
    if (
      op === 'mode' &&
      ['background', 'strict', 'compatible'].includes(
        typeof value === 'object' ? value?.mode : value,
      )
    ) {
      mode = typeof value === 'object' ? value.mode : value;
      epoch = typeof value === 'object' ? value.epoch : epoch;
      paused = false;
      reason = null;
      requests = [];
      armed = null;
    } else if (op === 'arm') {
      if (paused || armed || requests.length)
        return { version: 1, paused: true, reason: reason || 'busy', mode };
      armed = value;
    } else if (op === 'finish') {
      const rows = requests.filter((x) => x.nonce === value);
      requests = [];
      armed = null;
      return { version: 1, mode, paused, reason, requests: rows };
    } else if (op === 'release') {
      mode = 'compatible';
      armed = null;
      requests = [];
      paused = false;
      reason = null;
    }
    return { version: 1, mode, paused, reason };
  };
  const wrapped = function (url, target, features) {
    if (url === secret) return control;
    if (mode === 'compatible') return Reflect.apply(originalOpen, this, arguments);
    return request(url, target, features);
  };
  Object.defineProperty(wrapped, '__fblPopupGuard', { value: true });
  Object.defineProperty(window, 'open', { value: wrapped, writable: false, configurable: false });
  Object.defineProperty(window, 'focus', {
    value: function () {
      if (mode === 'compatible') return Reflect.apply(originalFocus, this, arguments);
    },
    writable: false,
    configurable: false,
  });
  const blocksTarget = (target) =>
    typeof target === 'string' &&
    target &&
    !['_self', '_top', '_parent'].includes(target.toLowerCase());
  const blockLink = (event) => {
    if (mode === 'compatible') return;
    const anchor = event.composedPath().find((x) => x?.tagName === 'A');
    if (
      anchor &&
      (blocksTarget(anchor.target || document.querySelector('base')?.target) ||
        (event.type === 'auxclick' && event.button === 1) ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey)
    ) {
      event.preventDefault();
      pause('target_link_requires_confirmation');
    }
  };
  window.addEventListener('click', blockLink, true);
  window.addEventListener('auxclick', blockLink, true);
  window.addEventListener(
    'submit',
    (event) => {
      if (mode === 'compatible') return;
      if (
        blocksTarget(
          event.submitter?.formTarget ||
            event.target?.target ||
            document.querySelector('base')?.target,
        )
      ) {
        event.preventDefault();
        pause('target_form_requires_confirmation');
      }
    },
    true,
  );
  Object.defineProperty(globalThis.HTMLFormElement.prototype, 'submit', {
    configurable: false,
    writable: false,
    value: function () {
      if (
        mode !== 'compatible' &&
        blocksTarget(this.target || document.querySelector('base')?.target)
      ) {
        pause('target_form_requires_confirmation');
        return;
      }
      return Reflect.apply(originalSubmit, this, arguments);
    },
  });
}

const POPUP_REASONS = new Set([
  'capacity',
  'unsupported_url',
  'cross_origin_requires_confirmation',
  'outside_action',
  'window_relationship_required',
  'strict_mode',
  'target_link_requires_confirmation',
  'target_form_requires_confirmation',
  'unprotected_document',
  'unsupported_frames',
  'raw_context_unsupported',
  'mode_unconfirmed',
]);
const policyFail = (code, preDispatch = true) => Object.assign(Error(code), { code, preDispatch });
const POLICY_READS = new Set([
  'popup.policy',
  'dialog',
  'popup_catalog',
  'tabs',
  'snapshot',
  'semantic_snapshot',
  'page.observe',
  'page.parse',
  'frame_catalog',
  'screenshot',
  'interaction.capture',
  'interaction.bounds',
  'official.ready_state',
  'images',
  'console',
  'cdp.events',
  'network.inspect',
]);
export class PopupPolicy {
  constructor(executor) {
    this.executor = executor;
    this.rows = new Map();
  }
  enabled(t) {
    return ['background', 'strict', 'compatible'].includes(t?.popupPolicy);
  }
  mode(t) {
    return t?.popupPolicy || 'compatible';
  }
  async install(t, tabId, guard) {
    if (!this.enabled(t)) return;
    if (this.rows.has(tabId)) return;
    if (this.rows.size >= 256) throw policyFail('POPUP_POLICY_UNAVAILABLE');
    const target = { tabId };
    if (!this.executor.attached.has(tabId)) {
      await this.executor.api.debugger.attach(target, '1.3');
      this.executor.attached.add(tabId);
      guard();
    }
    const row = { task: t, token: crypto.randomUUID(), scripts: [], blocked: null, epoch: 0 };
    row.binding = '__fblPopupBlocked_' + crypto.randomUUID().replaceAll('-', '');
    row.listener = (source, event, params) => {
      if (
        source.tabId !== tabId ||
        source.sessionId ||
        event !== 'Runtime.bindingCalled' ||
        params.name !== row.binding ||
        typeof params.payload !== 'string' ||
        params.payload.length > 256
      )
        return;
      let data;
      try {
        data = JSON.parse(params.payload);
      } catch {
        return;
      }
      if (
        data.epoch !== row.epoch ||
        !POPUP_REASONS.has(data.reason) ||
        row.noticed ||
        this.rows.get(tabId) !== row ||
        this.executor.leases.get(tabId) !== t.id ||
        t.revoked
      )
        return;
      row.noticed = true;
      row.blocked = data.reason;
      row.pendingNotice = this.notify(t, tabId, 'pause', data.reason).catch(() => {
        row.blocked = 'state_unconfirmed';
      });
    };
    this.rows.set(tabId, row);
    try {
      this.executor.api.debugger.onEvent.addListener(row.listener);
      await this.executor.api.debugger.sendCommand({ tabId }, 'Runtime.addBinding', {
        name: row.binding,
      });
      guard();
      await this.script(row, tabId);
      guard();
    } catch (e) {
      row.blocked = 'installation_failed';
      throw e;
    }
  }
  async script(row, tabId) {
    const source = `(${installPopupGuard.toString()})(${JSON.stringify(row.token)},${JSON.stringify(this.mode(row.task))},${JSON.stringify({ binding: row.binding, epoch: row.epoch })})`;
    await this.executor.api.debugger.sendCommand({ tabId }, 'Page.enable', {});
    const added = await this.executor.api.debugger.sendCommand(
      { tabId },
      'Page.addScriptToEvaluateOnNewDocument',
      { source },
    );
    if (typeof added?.identifier !== 'string') throw policyFail('POPUP_POLICY_UNAVAILABLE');
    row.scripts.push(added.identifier);
  }
  async control(t, tabId, op, value) {
    const row = this.rows.get(tabId);
    if (!row || row.task !== t) throw policyFail('POPUP_POLICY_UNPROTECTED');
    const r = await this.executor.api.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: `(function(secret,op,value){const c=window.open.__fblPopupGuard===true?window.open(secret):null;return typeof c==='function'?c(op,value):null})(${JSON.stringify(row.token)},${JSON.stringify(op)},${JSON.stringify(value ?? null)})`,
      returnByValue: true,
      timeout: 1000,
    });
    if (r.exceptionDetails || r.result?.value?.version !== 1)
      throw policyFail('POPUP_POLICY_UNPROTECTED');
    return r.result.value;
  }
  async worldControl(t, tabId, contextId, op, value) {
    const row = this.rows.get(tabId);
    if (!row || row.task !== t) throw policyFail('POPUP_POLICY_UNPROTECTED');
    const r = await this.executor.api.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      contextId,
      expression: `(function(secret,op,value){const c=window.open.__fblPopupGuard===true?window.open(secret):null;return typeof c==='function'?c(op,value):null})(${JSON.stringify(row.token)},${JSON.stringify(op)},${JSON.stringify(value ?? null)})`,
      returnByValue: true,
      timeout: 1000,
    });
    if (r.exceptionDetails || r.result?.value?.version !== 1)
      throw policyFail('POPUP_POLICY_UNPROTECTED');
    return r.result.value;
  }
  async guardWorld(t, p, target, frame, contextId, guard) {
    if (!this.enabled(t) || this.mode(t) === 'compatible' || !contextId) return;
    const row = this.rows.get(p.tabId),
      lease = row?.lease;
    if (!row || row.task !== t || !lease || frame.parentId || target.sessionId)
      throw policyFail('POPUP_POLICY_UNPROTECTED');
    row.worlds ??= new Map();
    if (row.loader !== frame.loaderId) {
      row.worlds.clear();
      row.loader = frame.loaderId;
      lease.loader = frame.loaderId;
    }
    if (!row.worlds.has(contextId)) {
      const r = await this.executor.api.debugger.sendCommand(target, 'Runtime.callFunctionOn', {
        executionContextId: contextId,
        functionDeclaration: installPopupGuard.toString(),
        arguments: [
          { value: row.token },
          { value: this.mode(t) },
          { value: { binding: row.binding, epoch: row.epoch || 0 } },
        ],
        returnByValue: true,
      });
      guard();
      if (r.exceptionDetails) throw policyFail('POPUP_POLICY_UNPROTECTED');
      if (row.worlds.size >= 8) throw policyFail('POPUP_POLICY_UNAVAILABLE');
      row.worlds.set(contextId, true);
    }
    const status = await this.worldControl(t, p.tabId, contextId, 'status');
    guard();
    if (status.paused || status.mode !== this.mode(t)) throw policyFail('POPUP_POLICY_PAUSED');
    const armed = await this.worldControl(t, p.tabId, contextId, 'arm', lease.nonce);
    guard();
    if (armed.paused) throw policyFail('POPUP_POLICY_PAUSED');
    lease.worlds.add(contextId);
  }
  async finish(t, lease) {
    const status = await this.control(t, lease.tabId, 'finish', lease.nonce);
    const tree = await this.executor.api.debugger.sendCommand(
      { tabId: lease.tabId },
      'Page.getFrameTree',
      {},
    );
    if (tree.frameTree?.frame?.loaderId === lease.loader) {
      for (const context of lease.worlds) {
        const s = await this.worldControl(t, lease.tabId, context, 'finish', lease.nonce);
        status.requests.push(...s.requests);
        if (s.paused) {
          status.paused = true;
          status.reason = s.reason;
        }
      }
    } else {
      lease.row.worlds?.clear();
      lease.row.loader = tree.frameTree?.frame?.loaderId;
    }
    if (status.requests.length > 1) {
      status.paused = true;
      status.reason = 'capacity';
    }
    return status;
  }
  async notify(t, tabId, operation, reason) {
    if (operation === 'pause') t.popupPolicyPaused = reason;
    if (!this.executor.onPopupPolicyState) return;
    const result = await this.executor.onPopupPolicyState({
      taskId: t.id,
      generation: t.generation,
      modeGeneration: t.policy?.modeGeneration,
      tabId,
      operation,
      ...(reason ? { reason } : {}),
    });
    if (result?.verified !== true || result.generation !== t.generation)
      throw policyFail('POPUP_POLICY_STATE_UNCONFIRMED');
  }
  async before(t, p) {
    const read =
      POLICY_READS.has(p.action) ||
      (p.action === 'execution.guard' && ['status', 'failure'].includes(p.options?.operation)) ||
      (p.action === 'cdp.send' && p.method === 'Page.getFrameTree');
    if (t?.popupPolicyChanging && !read) throw policyFail('POPUP_POLICY_BUSY');
    if (!this.enabled(t) || read) return null;
    if (t.popupPolicyPaused || [...this.rows.values()].some((x) => x.task === t && x.blocked))
      throw policyFail('POPUP_POLICY_PAUSED');
    if (this.mode(t) === 'compatible') return null;
    if (['new_tab', 'official.new_tab'].includes(p.action)) return null;
    if (
      p.action === 'cdp.send' &&
      (['Page.createIsolatedWorld', 'Runtime.callFunctionOn'].includes(p.method) ||
        p.params?.contextId !== undefined ||
        p.params?.executionContextId !== undefined ||
        p.params?.uniqueContextId !== undefined ||
        (p.method === 'Page.addScriptToEvaluateOnNewDocument' && p.params?.worldName))
    ) {
      await this.notify(t, p.tabId, 'pause', 'raw_context_unsupported');
      throw policyFail('POPUP_POLICY_UNPROTECTED');
    }
    const guard = () => {
      this.executor.check(t, p);
      if (this.executor.leases.get(p.tabId) !== t.id || t.paused || t.pauseRequested)
        throw policyFail('POPUP_POLICY_PAUSED');
    };
    if (['navigate', 'official.goto_url'].includes(p.action)) {
      await this.install(t, p.tabId, guard);
      return null;
    }
    const row = this.rows.get(p.tabId);
    if (!row || row.task !== t) {
      await this.notify(t, p.tabId, 'pause', 'unprotected_document');
      throw policyFail('POPUP_POLICY_UNPROTECTED');
    }
    if (row.blocked) throw policyFail('POPUP_POLICY_PAUSED');
    const tree = await this.executor.api.debugger.sendCommand(
      { tabId: p.tabId },
      'Page.getFrameTree',
      {},
    );
    guard();
    // 中文注释：第一批只覆盖无子框架的顶层新文档，不对未知 OOPIF/旧页面放行写入。
    if (tree.frameTree?.childFrames?.length) {
      await this.notify(t, p.tabId, 'pause', 'unsupported_frames');
      throw policyFail('POPUP_POLICY_UNPROTECTED');
    }
    if (row.loader !== tree.frameTree?.frame?.loaderId) {
      row.worlds?.clear();
      row.loader = tree.frameTree?.frame?.loaderId;
    }
    for (const context of row.worlds?.keys() || []) {
      const s = await this.worldControl(t, p.tabId, context, 'status');
      guard();
      if (s.paused) {
        await this.notify(t, p.tabId, 'pause', s.reason);
        throw policyFail('POPUP_POLICY_PAUSED');
      }
    }
    const status = await this.control(t, p.tabId, 'status');
    guard();
    if (status.paused || status.mode !== this.mode(t)) {
      await this.notify(t, p.tabId, 'pause', status.reason || 'mode_unconfirmed');
      throw policyFail('POPUP_POLICY_PAUSED');
    }
    // 恢复和进展配置仅核验保护，不把刷新加载或只读配置当成可接管弹窗的用户动作。
    if (p.action === 'execution.guard' && ['recover', 'progress'].includes(p.options?.operation))
      return null;
    const nonce = crypto.randomUUID();
    const armed = await this.control(t, p.tabId, 'arm', nonce);
    guard();
    if (armed.paused) throw policyFail('POPUP_POLICY_PAUSED');
    const lease = { row, nonce, tabId: p.tabId, loader: row.loader, worlds: new Set() };
    row.lease = lease;
    (t.popupPolicyActive ??= new Set()).add(lease);
    return lease;
  }
  // 启动脚本可能早于两端租约登记；暂停随可信建页回执交接，不依赖早到通知。
  async createdReceipt(t, tabId, result) {
    if (!this.enabled(t) || this.mode(t) === 'compatible') return result;
    let state;
    try {
      if (this.executor.observers?.pending(t, tabId)) throw Error('native dialog');
      state = await this.control(t, tabId, 'status');
      const tree = await this.executor.api.debugger.sendCommand({ tabId }, 'Page.getFrameTree', {});
      if (tree.frameTree?.childFrames?.length)
        state = { ...state, paused: true, reason: 'unsupported_frames' };
      if (state.mode !== this.mode(t))
        state = { ...state, paused: true, reason: 'mode_unconfirmed' };
    } catch {
      state = { paused: true, reason: 'unprotected_document' };
    }
    const reason = t.popupPolicyPaused || state.reason;
    if (!state.paused && !t.popupPolicyPaused) return result;
    const fixed = POPUP_REASONS.has(reason) ? reason : 'unprotected_document';
    const row = this.rows.get(tabId);
    if (row?.task === t) row.blocked = fixed;
    t.popupPolicyPaused = fixed;
    return {
      ...result,
      popupPolicy: { mode: this.mode(t), paused: true, reason: fixed, opened: [] },
    };
  }
  async after(t, p, lease, result) {
    if (!lease) return result;
    try {
      const guard = () => {
        this.executor.check(t, p);
        if (
          this.executor.leases.get(p.tabId) !== t.id ||
          t.paused ||
          t.pauseRequested ||
          (p.modeGeneration !== undefined && t.policy?.modeGeneration !== p.modeGeneration)
        )
          throw policyFail('POPUP_POLICY_STALE', false);
      };
      let status;
      try {
        status = await this.finish(t, lease);
        guard();
      } catch (e) {
        lease.row.blocked = 'outcome_unknown';
        throw policyFail('POPUP_POLICY_OUTCOME_UNKNOWN', false);
      }
      if (!Array.isArray(status.requests) || status.requests.length > 8)
        throw policyFail('POPUP_POLICY_OUTCOME_UNKNOWN', false);
      const opened = [];
      // 显式后台链接也可能返回启动暂停；不能被源页的健康状态覆盖。
      if (result?.popupPolicy?.paused === true) {
        status.paused = true;
        status.reason = POPUP_REASONS.has(result.popupPolicy.reason)
          ? result.popupPolicy.reason
          : 'unprotected_document';
      }
      if (status.paused) {
        lease.row.blocked = status.reason || 'unsupported';
        try {
          await lease.row.pendingNotice;
          await this.notify(t, p.tabId, 'pause', status.reason || 'unsupported');
          guard();
        } catch {
          throw policyFail('POPUP_POLICY_OUTCOME_UNKNOWN', false);
        }
        if (p.action === 'cdp.send') throw policyFail('POPUP_POLICY_PAUSED', false);
        return {
          ...result,
          popupPolicy: { mode: status.mode, paused: true, reason: status.reason, opened: [] },
        };
      }
      if (status.requests.length && t.agentTabs.size >= 4) {
        lease.row.blocked = 'capacity';
        await this.notify(t, p.tabId, 'pause', 'capacity');
        guard();
        return {
          ...result,
          popupPolicy: { mode: status.mode, paused: true, reason: 'capacity', opened: [] },
        };
      }
      for (const request of status.requests) {
        if (request.nonce !== lease.nonce || typeof request.url !== 'string')
          throw policyFail('POPUP_POLICY_OUTCOME_UNKNOWN', false);
        try {
          guard();
          // 中文注释：先消耗队列，再创建本任务新页；失败后冻结，不重试开页。
          lease.row.blocked = 'opening';
          const child = await this.executor.openOwnedTab(
            t,
            { ...p, action: 'new_tab', requestId: crypto.randomUUID() },
            guard,
            request.url,
          );
          guard();
          const registered = await this.executor.onBackgroundPopup({
            taskId: t.id,
            generation: t.generation,
            modeGeneration: p.modeGeneration,
            tabId: child.tabId,
            openerTabId: p.tabId,
            event: 'background_created',
          });
          guard();
          if (registered?.generation !== t.generation || !registered.tabIds?.includes(child.tabId))
            throw policyFail('POPUP_POLICY_OUTCOME_UNKNOWN', false);
          if (child.popupPolicy?.paused) {
            await this.notify(t, child.tabId, 'pause', child.popupPolicy.reason);
            guard();
            status.paused = true;
            status.reason = child.popupPolicy.reason;
          }
          const entry = {
            candidateRef: crypto.randomUUID(),
            tabId: child.tabId,
            origin: new URL(request.url).origin,
            windowType: 'normal',
            managed: true,
          };
          (lease.row.opened ??= []).push(entry);
          lease.row.opened = lease.row.opened.slice(-16);
          opened.push(entry);
          lease.row.blocked = null;
        } catch (e) {
          lease.row.blocked = 'open_unconfirmed';
          throw policyFail('POPUP_POLICY_OUTCOME_UNKNOWN', false);
        }
      }
      if (status.paused) lease.row.blocked = status.reason || 'unsupported';
      if (p.action === 'cdp.send') {
        if (status.paused) throw policyFail('POPUP_POLICY_PAUSED', false);
        return result;
      }
      return {
        ...result,
        popupPolicy: {
          mode: status.mode,
          paused: !!status.paused,
          reason: status.reason || null,
          opened,
        },
      };
    } finally {
      if (lease.row.lease === lease) lease.row.lease = null;
      t.popupPolicyActive?.delete(lease);
    }
  }
  async abort(t, lease, error) {
    if (!lease) return;
    try {
      const status = await this.finish(t, lease);
      if (error?.preDispatch !== true || status.paused || status.requests?.length)
        lease.row.blocked = status.reason || 'action_interrupted';
    } catch {
      lease.row.blocked = 'action_interrupted';
    } finally {
      if (lease.row.lease === lease) lease.row.lease = null;
      t.popupPolicyActive?.delete(lease);
    }
  }
  async status(t, tabId) {
    let status = null,
      frames = false;
    if (this.executor.observers?.pending(t, tabId))
      return {
        supported: this.enabled(t),
        mode: this.mode(t),
        protected: false,
        paused: true,
        reason: 'native_dialog_open',
        coverage: 'fresh_top_level_without_frames',
      };
    if (this.enabled(t) && this.mode(t) !== 'compatible')
      try {
        status = await this.control(t, tabId, 'status');
        const tree = await this.executor.api.debugger.sendCommand(
          { tabId },
          'Page.getFrameTree',
          {},
        );
        frames = !!tree.frameTree?.childFrames?.length;
        if (tree.frameTree?.frame?.loaderId === this.rows.get(tabId)?.loader) {
          for (const context of this.rows.get(tabId)?.worlds?.keys() || []) {
            const local = await this.worldControl(t, tabId, context, 'status');
            if (local.paused) {
              status.paused = true;
              status.reason = local.reason;
            }
          }
        } else this.rows.get(tabId)?.worlds?.clear();
      } catch {}
    const row = this.rows.get(tabId),
      blocked =
        t.popupPolicyPaused ||
        [...this.rows.values()].find((x) => x.task === t && x.blocked)?.blocked;
    return {
      supported: this.enabled(t),
      mode: this.mode(t),
      protected: !!status && !frames,
      paused: !!blocked || !!row?.blocked || status?.paused === true,
      reason: frames
        ? 'unsupported_frames'
        : blocked ||
          row?.blocked ||
          status?.reason ||
          (!status && this.mode(t) !== 'compatible' ? 'unprotected_document' : null),
      coverage: 'fresh_top_level_without_frames',
    };
  }
  catalog(t, tabId) {
    return (this.rows.get(tabId)?.opened || []).filter(
      (x) => this.executor.leases.get(x.tabId) === t.id,
    );
  }
  setMode(t, mode, sourceTabId) {
    const next = (t.popupPolicyChange || Promise.resolve())
      .catch(() => {})
      .then(() => this.changeMode(t, mode, sourceTabId));
    t.popupPolicyChange = next;
    return next;
  }
  async changeMode(t, mode, sourceTabId) {
    if (!['background', 'strict', 'compatible'].includes(mode))
      throw policyFail('POPUP_POLICY_INVALID');
    if (t.popupPolicyActive?.size) throw policyFail('POPUP_POLICY_BUSY');
    // 中文注释：仅由可信扩展 UI 调用，普通脚本没有切兼容模式的接口。不重放被拦弹窗。
    for (const [id, row] of this.rows)
      if (row.task === t && this.executor.observers?.pending(t, id))
        throw policyFail('POPUP_POLICY_PAUSED');
    const expectedMode = t.policy?.modeGeneration;
    const guard = () => {
      if (t.revoked || (expectedMode !== undefined && t.policy.modeGeneration !== expectedMode))
        throw policyFail('POPUP_POLICY_STALE');
    };
    guard();
    t.popupPolicy = mode;
    t.popupPolicyPaused = null;
    t.popupPolicyChanging = true;
    try {
      for (const [tabId, row] of this.rows)
        if (row.task === t) {
          guard();
          await row.pendingNotice;
          row.epoch = (row.epoch || 0) + 1;
          row.noticed = false;
          row.blocked = null;
          await this.control(t, tabId, 'mode', { mode, epoch: row.epoch }).catch(() => {});
          guard();
          const tree = await this.executor.api.debugger.sendCommand(
            { tabId },
            'Page.getFrameTree',
            {},
          );
          if (tree.frameTree?.frame?.loaderId !== row.loader) row.worlds?.clear();
          for (const context of row.worlds?.keys() || [])
            await this.worldControl(t, tabId, context, 'mode', { mode, epoch: row.epoch });
          const old = [...row.scripts];
          await this.script(row, tabId);
          for (const identifier of old) {
            await this.executor.api.debugger.sendCommand(
              { tabId },
              'Page.removeScriptToEvaluateOnNewDocument',
              { identifier },
            );
            row.scripts.splice(row.scripts.indexOf(identifier), 1);
          }
        }
      guard();
      await this.notify(
        t,
        sourceTabId ?? [...this.rows].find(([, row]) => row.task === t)?.[0],
        'clear',
      );
      guard();
      t.popupPolicyPaused = null;
      // 新模式生效后站点仍可能主动开窗；这些新拦截不能被本次 clear 覆盖。
      for (const [tabId, row] of this.rows)
        if (row.task === t) {
          const state = await this.status(t, tabId);
          guard();
          if (state.paused) {
            await this.notify(
              t,
              tabId,
              'pause',
              POPUP_REASONS.has(state.reason) ? state.reason : 'unprotected_document',
            );
            guard();
            break;
          }
        }
      return { verified: true, mode };
    } catch (error) {
      t.popupPolicyPaused = 'mode_change_unconfirmed';
      throw error;
    } finally {
      t.popupPolicyChanging = false;
    }
  }
  async clear(t, tabId, restore = true) {
    const row = this.rows.get(tabId);
    if (!row || row.task !== t) return;
    row.blocked = null;
    if (restore) await this.control(t, tabId, 'release');
    const tree = await this.executor.api.debugger.sendCommand({ tabId }, 'Page.getFrameTree', {});
    if (restore && tree.frameTree?.frame?.loaderId === row.loader)
      for (const context of row.worlds?.keys() || [])
        await this.worldControl(t, tabId, context, 'release');
    for (const identifier of row.scripts)
      await this.executor.api.debugger.sendCommand(
        { tabId },
        'Page.removeScriptToEvaluateOnNewDocument',
        { identifier },
      );
    if (row.binding)
      await this.executor.api.debugger.sendCommand({ tabId }, 'Runtime.removeBinding', {
        name: row.binding,
      });
    this.forget(tabId);
  }
  forget(tabId) {
    const row = this.rows.get(tabId);
    if (row?.listener) this.executor.api.debugger.onEvent?.removeListener(row.listener);
    this.rows.delete(tabId);
  }
}
