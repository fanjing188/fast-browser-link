// 中文注释：执行保护只保存有界状态/摘要；不保存页面正文、输入值、请求头或完整URL。
const mutation = new Set([
  'click',
  'fill',
  'press',
  'ref_click',
  'ref_fill',
  'ref_press',
  'ref_set_checked',
  'ref_select_option',
  'files.upload',
  'interaction.click',
  'interaction.drag_coordinates',
  'interaction.drag_elements',
  'js.evaluate',
  'cdp.send',
  'dialog',
]);
const paced = new Set([
  ...mutation,
  'navigate',
  'new_tab',
  'official.goto_url',
  'official.new_tab',
  'scroll',
  'back',
]);
// 中文注释：页面激活已是受限逻辑选择，不算写入，不清除循环/失败计数。
const harmlessCdp = new Set([
  'Network.enable',
  'Page.getFrameTree',
  'Page.bringToFront',
  'Target.activateTarget',
]);
const isPaced = (p) =>
  paced.has(p.action) && !(p.action === 'cdp.send' && harmlessCdp.has(p.method));
const fail = (code) => Object.assign(Error(code), { preDispatch: true });
const origin = (value) => {
  try {
    const u = new URL(value);
    return /^https?:$/.test(u.protocol) ? u.origin : null;
  } catch {
    return null;
  }
};
export function retryDelay(value, now = Date.now()) {
  if (typeof value !== 'string' || value.length > 128) return 0;
  if (!/^\s*\d+\s*$/.test(value) && !/^\w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value))
    return 0;
  const seconds = /^\s*\d+\s*$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(seconds) ? Math.min(86400000, Math.max(0, seconds)) : 0;
}
// 中文注释：固定隔离世界探针；不读控件当前值，不回传标题/正文。任何可编辑区/框架均禁止自动刷新。
export function inspectExecutionSurface(seed = String(Date.now()) + Math.random(), selectors = []) {
  const root = document.documentElement;
  const prior = globalThis.__fblExecutionSurface;
  if (!prior || prior.root !== root) globalThis.__fblExecutionSurface = { root, epoch: seed };
  let hash = 2166136261,
    used = 0,
    count = 0;
  const visible = (node) => {
    const css = globalThis.getComputedStyle(node);
    return (
      !node.closest(
        '[data-fast-automation-overlay],[data-fast-browser-link-overlay],[data-hermes-browser-overlay],#fast-browser-link-overlay,script,style,noscript',
      ) &&
      css.display !== 'none' &&
      css.visibility !== 'hidden' &&
      node.getClientRects().length > 0
    );
  };
  const fold = (value) => {
    for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  };
  fold(String(globalThis.scrollX) + ',' + String(globalThis.scrollY));
  let notices = '';
  for (const node of document.querySelectorAll('h1,h2,h3,[role="alert"]')) {
    if (!visible(node)) continue;
    notices += ' ' + node.textContent.slice(0, 500);
    if (notices.length >= 4000) break;
  }
  for (const node of document.querySelectorAll('h1,h2,h3,p,td,th,li,button,a,[role="row"]')) {
    if (!visible(node) || node.closest('[contenteditable]:not([contenteditable="false"])'))
      continue;
    const value = (node.textContent || '').replace(/\s+/g, ' ').slice(0, 200);
    fold(value);
    used += value.length;
    if (++count >= 256 || used >= 8000) break;
  }
  const editable = !!document.querySelector(
    'form,input,textarea,select,[contenteditable]:not([contenteditable="false"])',
  );
  const frames = !!document.querySelector('iframe,frame,object,embed');
  const reason = /captcha|verify you are human|unusual traffic|验证码|人机验证/i.test(notices)
    ? 'captcha'
    : /sign in to continue|session expired|登录过期|请先登录/i.test(notices)
      ? 'login'
      : /access denied|permission denied|forbidden|无权访问|权限不足/i.test(notices)
        ? 'permission'
        : /too many requests|rate limit|访问频繁|请求过于频繁|操作频繁/i.test(notices)
          ? 'rate_limit'
          : /quota exceeded|daily limit|额度用尽|配额耗尽/i.test(notices)
            ? 'quota'
            : /service unavailable|temporarily unavailable|internal server error|failed to load|服务暂不可用|加载失败|系统繁忙/i.test(
                  notices,
                )
              ? 'transient'
              : document.readyState === 'loading'
                ? 'loading'
                : 'ready';
  let business = null;
  if (selectors.length) {
    let value = '',
      matched = 0,
      complete = true;
    for (const spec of selectors) {
      const nodes = document.querySelectorAll(spec.selector);
      if (nodes.length > 256) complete = false;
      value += '|' + nodes.length;
      matched += nodes.length;
      for (const node of [...nodes].slice(0, 256)) {
        const raw = spec.attribute ? node.getAttribute(spec.attribute) : node.textContent;
        if (raw === null || (raw || '').length > 1000) complete = false;
        value += ':' + (raw || '').slice(0, 1000);
        if (value.length > 16000) {
          complete = false;
          break;
        }
      }
      if (value.length > 16000) break;
    }
    let digest = 2166136261;
    for (let i = 0; i < value.length; i++)
      digest = Math.imul(digest ^ value.charCodeAt(i), 16777619);
    business = { digest: (digest >>> 0).toString(16), complete, matched };
  }
  return {
    business,
    reason,
    editable,
    frames,
    epoch: globalThis.__fblExecutionSurface.epoch,
    progress: (hash >>> 0).toString(16),
    readyState: document.readyState,
  };
}
export class ExecutionResilience {
  constructor(
    executor,
    { now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {},
  ) {
    this.executor = executor;
    this.now = now;
    this.sleep = sleep;
    this.tasks = new WeakMap();
    this.sites = new Map();
  }
  state(t) {
    let s = this.tasks.get(t);
    if (!s) {
      s = {
        enabled: false,
        dirty: new Set(),
        created: new Set(),
        health: new Map(),
        reloads: new Set(),
        failures: 0,
        circuitUntil: 0,
        loops: new Map(),
        allDirty: false,
        blocked: null,
        network: new Set(),
        progressSelectors: new Map(),
        completedDownloads: new Map(),
        reports: new Set(),
        lastFailureHealth: null,
      };
      this.tasks.set(t, s);
    }
    return s;
  }
  loop(s, tabId) {
    if (!s.loops.has(tabId)) {
      if (s.loops.size >= 64) throw fail('GUARD_CAPACITY');
      s.loops.set(tabId, { stalls: 0, lastAction: null, baseline: null });
    }
    return s.loops.get(tabId);
  }
  site(key) {
    let b = this.sites.get(key);
    if (!b) {
      for (const [k, v] of this.sites)
        if (!v.active && this.now() - v.touched > 900000 && v.until <= this.now())
          this.sites.delete(k);
      if (this.sites.size >= 128) throw fail('GUARD_CAPACITY');
      b = {
        delay: 0,
        until: 0,
        next: 0,
        active: 0,
        queued: 0,
        successes: 0,
        touched: this.now(),
        reason: null,
        seen: new Set(),
      };
      this.sites.set(key, b);
    }
    b.touched = this.now();
    return b;
  }
  penalty(b, delay = 0, reason = 'rate_limit') {
    b.delay = Math.min(30000, Math.max(500, b.delay * 2));
    b.until = Math.max(b.until, this.now() + Math.max(b.delay, delay));
    b.successes = 0;
    b.reason = reason;
  }
  observe(source, method, p) {
    if (
      source?.sessionId ||
      method !== 'Network.responseReceived' ||
      !['Document', 'XHR', 'Fetch'].includes(p?.type)
    )
      return;
    const t = this.executor.tasks.get(this.executor.leases.get(source.tabId));
    if (!t || t.revoked || !this.state(t).enabled) return;
    const site = origin(p.response?.url);
    if (!site) return;
    const s = this.state(t),
      h = s.health.get(source.tabId);
    if (!h || h.origin !== site) return;
    const b = this.site(site),
      id = source.tabId + ':' + p.requestId + ':' + p.response.status;
    if (b.seen.has(id)) return;
    b.seen.add(id);
    if (b.seen.size > 1024) b.seen.delete(b.seen.values().next().value);
    const status = p.response.status;
    if (status === 429 || status === 503) {
      const entry = Object.entries(p.response.headers || {}).find(
        ([name]) => name.toLowerCase() === 'retry-after',
      );
      const delay = retryDelay(entry?.[1], this.now());
      if (delay >= 86400000) b.manual = true;
      this.penalty(b, delay, status === 429 ? 'rate_limit' : 'service_unavailable');
    } else if (status === 401 || status === 403) {
      s.blocked = { reason: status === 401 ? 'login' : 'permission', progress: h.progress };
    } else if (status >= 200 && status < 300 && this.now() >= b.until) {
      b.manual = false;
      if (++b.successes >= 4) {
        b.delay = b.delay < 500 ? 0 : Math.floor(b.delay / 2);
        b.successes = 0;
        if (!b.delay) b.reason = null;
      }
    }
  }
  downloadCompleted(record) {
    const t = this.executor.tasks.get(record.taskId);
    if (
      !t ||
      t.revoked ||
      t.generation !== record.generation ||
      this.executor.leases.get(record.tabId) !== t.id
    )
      return;
    const s = this.state(t);
    if (!s.completedDownloads.has(record.tabId) && s.completedDownloads.size >= 64) return;
    s.completedDownloads.set(record.tabId, (s.completedDownloads.get(record.tabId) || 0) + 1);
  }
  note(t, p) {
    if (p.action === 'cdp.send' && harmlessCdp.has(p.method)) return;
    if (t && mutation.has(p.action)) {
      const s = this.state(t);
      if (s.dirty.size >= 256) s.allDirty = true;
      else s.dirty.add(p.tabId);
    }
  }
  async enter(t, p) {
    const s = t && this.state(t);
    if (!s?.enabled || !isPaced(p)) return () => {};
    const generation = t.generation,
      mode = t.policy?.modeGeneration;
    const check = () => {
      this.executor.check(t, p);
      if (
        t.paused ||
        t.pauseRequested ||
        t.generation !== generation ||
        t.policy?.modeGeneration !== mode ||
        (Number.isInteger(p.tabId) && this.executor.leases.get(p.tabId) !== t.id)
      )
        throw fail('GUARD_INTERRUPTED');
    };
    check();
    if (s.blocked) throw fail('EXECUTION_HANDOFF');
    if (s.progressSelectors.has(p.tabId) && s.health.get(p.tabId)?.business?.complete !== true)
      throw fail('EXECUTION_PROGRESS_INCOMPLETE');
    if (this.loop(s, p.tabId).stalls >= 3) throw fail('EXECUTION_NO_PROGRESS');
    if (s.circuitUntil > this.now()) throw fail('EXECUTION_CIRCUIT_OPEN');
    const tab = Number.isInteger(p.tabId) ? await this.executor.api.tabs.get(p.tabId) : null;
    const key = origin(p.url || tab?.url);
    if (!key) return () => {};
    const b = this.site(key);
    if (b.manual) throw fail('EXECUTION_HANDOFF');
    if (b.queued >= 16) throw fail('GUARD_CAPACITY');
    const started = this.now();
    b.queued++;
    try {
      while (true) {
        check();
        if (s.blocked || b.manual) throw fail('EXECUTION_HANDOFF');
        if (s.progressSelectors.has(p.tabId) && s.health.get(p.tabId)?.business?.complete !== true)
          throw fail('EXECUTION_PROGRESS_INCOMPLETE');
        if (s.circuitUntil > this.now()) throw fail('EXECUTION_CIRCUIT_OPEN');
        if (this.loop(s, p.tabId).stalls >= 3) throw fail('EXECUTION_NO_PROGRESS');
        const wait = Math.max(0, b.until - this.now(), b.next - this.now());
        const limit = b.delay ? 1 : 4;
        if (wait > 5000 || this.now() - started >= 5000) throw fail('ACCESS_COOLDOWN');
        if (!wait && b.active < limit) {
          b.active++;
          b.next = this.now() + b.delay;
          break;
        }
        await this.sleep(Math.min(50, Math.max(10, wait)));
      }
    } finally {
      b.queued--;
    }
    let released = false;
    return () => {
      if (!released) {
        released = true;
        b.active--;
        b.touched = this.now();
      }
    };
  }
  finish(t, p, error, result = null) {
    const s = t && this.state(t);
    if (
      s &&
      !error &&
      ['new_tab', 'official.new_tab'].includes(p.action) &&
      Number.isInteger(result?.tabId) &&
      s.created.size < 256
    )
      s.created.add(result.tabId);
    if (!s?.enabled || !isPaced(p)) return;
    if (error) {
      if (
        error.preDispatch === true &&
        ![
          'ACCESS_COOLDOWN',
          'EXECUTION_CIRCUIT_OPEN',
          'EXECUTION_NO_PROGRESS',
          'EXECUTION_PROGRESS_INCOMPLETE',
          'EXECUTION_HANDOFF',
          'GUARD_INTERRUPTED',
          'GUARD_CAPACITY',
        ].includes(error.message)
      ) {
        s.lastFailureHealth = s.health.get(p.tabId)?.id;
        if (++s.failures >= 3) s.circuitUntil = this.now() + 30000;
      }
    } else {
      s.failures = 0;
    }
    this.loop(s, p.tabId).lastAction = error
      ? null
      : { action: p.action, ref: p.ref || p.selector || p.url || '', tabId: p.tabId };
  }
  async inspect(t, p, target, guard) {
    guard();
    const doc = this.executor.docs.get(p.tabId) || 0;
    const tab = await this.executor.api.tabs.get(p.tabId);
    guard();
    const site = origin(tab.url);
    if (!site) throw fail('RECOVERY_UNAVAILABLE');
    const frame = (await this.executor.checkedFrameTree(target, t, guard, false)).frame;
    guard();
    const world = await this.executor.api.debugger.sendCommand(target, 'Page.createIsolatedWorld', {
      frameId: frame.id,
      worldName: 'fast-execution-health',
      grantUniveralAccess: false,
    });
    guard();
    const r = await this.executor.api.debugger.sendCommand(target, 'Runtime.callFunctionOn', {
      executionContextId: world.executionContextId,
      functionDeclaration: inspectExecutionSurface.toString(),
      arguments: [
        { value: crypto.randomUUID() },
        { value: this.state(t).progressSelectors.get(p.tabId) || [] },
      ],
      returnByValue: true,
    });
    guard();
    if ((this.executor.docs.get(p.tabId) || 0) !== doc) throw fail('RECOVERY_STALE');
    if (r.exceptionDetails || !r.result?.value?.epoch) throw fail('RECOVERY_UNAVAILABLE');
    const value = {
      ...r.result.value,
      origin: site,
      loaderId: frame.loaderId,
      doc: this.executor.docs.get(p.tabId) || 0,
    };
    value.loopProgress =
      (value.business?.complete ? value.business.digest : value.progress) +
      ':' +
      (this.state(t).completedDownloads.get(p.tabId) || 0);
    return value;
  }
  status(s, h, tabId) {
    const b = this.site(h.origin);
    const unsafe = s.allDirty || s.dirty.has(tabId) || h.editable || h.frames || !s.owned;
    return {
      reason: s.blocked?.reason || h.reason,
      reloadAllowed: h.reason === 'transient' && !unsafe && !s.reloads.has(tabId),
      reloadBlocked: unsafe ? 'page_state_protected' : s.reloads.has(tabId) ? 'reload_limit' : null,
      progress: h.progress,
      businessProgress: h.business,
      documentEpoch: h.epoch,
      healthId: h.id,
      access: {
        delayMs: b.delay,
        retryAfterMs: Math.max(0, b.until - this.now(), b.next - this.now()),
        concurrency: b.delay ? 1 : 4,
        reason: b.reason,
        requiresUser: b.manual === true,
      },
      protection: {
        failures: s.failures,
        circuitOpen: s.circuitUntil > this.now(),
        retryAfterMs: Math.max(0, s.circuitUntil - this.now()),
        stalled: this.loop(s, tabId).stalls >= 3,
        progressIncomplete: !!s.progressSelectors.get(tabId) && h.business?.complete !== true,
      },
    };
  }
  async execute(t, p, target, guard) {
    if (['product_fill', 'product_work'].includes(t.executionLane)) throw fail('RECOVERY_BLOCKED');
    const s = this.state(t);
    s.enabled = true;
    const op = p.options?.operation;
    const allowed =
      op === 'progress'
        ? ['operation', 'healthId', 'selectors']
        : op === 'recover'
          ? ['operation', 'healthId']
          : op === 'failure'
            ? ['operation', 'healthId', 'code']
            : ['operation'];
    if (
      !['status', 'recover', 'failure', 'progress'].includes(op) ||
      Object.keys(p.options).some((k) => !allowed.includes(k)) ||
      (op !== 'status' &&
        (typeof p.options.healthId !== 'string' ||
          !p.options.healthId ||
          p.options.healthId.length > 128))
    )
      throw fail('INVALID_OPTIONS');
    if (op === 'failure') {
      if (
        ![
          'element_timeout',
          'ambiguous_target',
          'incomplete_target_scope',
          'target_disabled',
          'target_readonly',
          'target_occluded',
          'target_not_actionable',
          'page_not_ready',
        ].includes(p.options.code)
      )
        throw fail('INVALID_OPTIONS');
      const h = s.health.get(p.tabId);
      if (!h || h.id !== p.options.healthId || this.now() - h.at > 60000)
        throw fail('RECOVERY_STALE');
      if (!s.reports.has(h.id) && s.lastFailureHealth !== h.id) {
        if (s.reports.size >= 256) throw fail('GUARD_CAPACITY');
        s.reports.add(h.id);
        if (++s.failures >= 3) s.circuitUntil = this.now() + 30000;
      }
      return { recorded: true, protection: this.status(s, h, p.tabId).protection };
    }
    const prior = s.health.get(p.tabId),
      h = await this.inspect(t, p, target, guard);
    h.id = crypto.randomUUID();
    h.at = this.now();
    s.owned =
      t.agentTabs?.has(p.tabId) === true &&
      s.created.has(p.tabId) &&
      !t.credentialTabs?.has(p.tabId);
    if (s.blocked && s.blocked.progress !== h.progress && h.reason === 'ready') s.blocked = null;
    if (
      h.reason === 'captcha' ||
      h.reason === 'login' ||
      h.reason === 'permission' ||
      h.reason === 'quota'
    )
      s.blocked = { reason: h.reason, progress: h.progress };
    if (h.reason === 'rate_limit' && prior?.reason !== 'rate_limit')
      this.penalty(this.site(h.origin));
    if (op === 'status') {
      const loop = this.loop(s, p.tabId);
      const last = loop.lastAction;
      if (
        last &&
        last.tabId === p.tabId &&
        ['click', 'ref_click', 'scroll', 'navigate', 'official.goto_url'].includes(last.action)
      ) {
        const signature = JSON.stringify(last);
        if (
          prior &&
          (h.business?.complete && prior.business?.complete
            ? prior.loopProgress === h.loopProgress
            : prior.loopProgress === h.loopProgress && prior.epoch === h.epoch)
        )
          loop.stalls = loop.baseline?.action === signature ? loop.stalls + 1 : 1;
        else loop.stalls = 0;
        loop.baseline = {
          action: signature,
          progress: h.loopProgress,
          epoch: h.epoch,
        };
        loop.lastAction = null;
      } else if (last || (loop.baseline && loop.baseline.progress !== h.loopProgress)) {
        loop.stalls = 0;
        loop.baseline = null;
        loop.lastAction = null;
      }
      if (!s.health.has(p.tabId) && s.health.size >= 64) throw fail('GUARD_CAPACITY');
      s.health.set(p.tabId, h);
      if (!s.network.has(p.tabId)) {
        await this.executor.api.debugger.sendCommand(target, 'Network.enable', {
          maxTotalBufferSize: 1048576,
          maxResourceBufferSize: 65536,
        });
        guard();
        if (s.network.size >= 256) s.network.clear();
        s.network.add(p.tabId);
      }
      return this.status(s, h, p.tabId);
    }
    if (
      !prior ||
      prior.id !== p.options.healthId ||
      this.now() - prior.at > 10000 ||
      prior.epoch !== h.epoch ||
      prior.loaderId !== h.loaderId ||
      prior.doc !== h.doc ||
      prior.progress !== h.progress ||
      prior.origin !== h.origin
    )
      throw fail('RECOVERY_STALE');
    if (op === 'progress') {
      const selectors = p.options.selectors;
      if (
        !Array.isArray(selectors) ||
        selectors.length < 1 ||
        selectors.length > 8 ||
        selectors.some(
          (x) =>
            !x ||
            typeof x !== 'object' ||
            Array.isArray(x) ||
            Object.keys(x).some((k) => !['selector', 'attribute'].includes(k)) ||
            typeof x.selector !== 'string' ||
            !x.selector ||
            x.selector.length > 512 ||
            (x.attribute !== undefined &&
              (typeof x.attribute !== 'string' ||
                !/^(data-[a-z0-9_-]{1,48}|aria-rowindex|id)$/.test(x.attribute))),
        )
      )
        throw fail('INVALID_OPTIONS');
      const existing = s.progressSelectors.get(p.tabId),
        loop = this.loop(s, p.tabId);
      if (
        (existing && JSON.stringify(existing) !== JSON.stringify(selectors)) ||
        (!existing && (loop.baseline || loop.lastAction || loop.stalls))
      )
        throw fail('RECOVERY_BLOCKED');
      if (!existing && s.progressSelectors.size >= 64) throw fail('GUARD_CAPACITY');
      s.progressSelectors.set(p.tabId, structuredClone(selectors));
      try {
        const current = await this.inspect(t, p, target, guard);
        current.id = crypto.randomUUID();
        current.at = this.now();
        s.health.set(p.tabId, current);
        return this.status(s, current, p.tabId);
      } catch (error) {
        if (!existing) s.progressSelectors.delete(p.tabId);
        throw error;
      }
    }
    const status = this.status(s, h, p.tabId);
    if (
      !status.reloadAllowed ||
      s.blocked ||
      s.circuitUntil > this.now() ||
      status.access.retryAfterMs > 0
    )
      throw fail('RECOVERY_BLOCKED');
    // 中文注释：配额在派发前消耗；异常/断线也不允许换编号补发刷新。
    if (s.reloads.size >= 256) throw fail('GUARD_CAPACITY');
    s.reloads.add(p.tabId);
    s.health.delete(p.tabId);
    guard();
    try {
      await this.executor.api.debugger.sendCommand(target, 'Page.reload', { ignoreCache: false });
    } catch {
      throw Object.assign(Error('RECOVERY_OUTCOME_UNKNOWN'), {
        outcomeUnknown: true,
        preDispatch: false,
      });
    }
    try {
      guard();
    } catch {
      throw Object.assign(Error('RECOVERY_OUTCOME_UNKNOWN'), {
        outcomeUnknown: true,
        preDispatch: false,
      });
    }
    return { reloaded: true, delivery: 'confirmed', effect: 'unverified' };
  }
}
