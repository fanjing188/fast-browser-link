// 中文注释：由 FBL 通过 executeScript 的 ISOLATED 顶层世界安装；函数必须可独立序列化。
export function installProductFillAuthority(config) {
  const doc = window.document;
  if (
    window.top !== window ||
    !config ||
    config.documentUrl !== doc.URL ||
    typeof config.channel !== 'string' ||
    config.channel.length < 16
  ) {
    return { installed: false, error: 'invalid_installation' };
  }
  const marker = Symbol.for('fbl.product_fill.authority.v1');
  if (Object.hasOwn(globalThis, marker))
    return Object.getOwnPropertyDescriptor(globalThis, marker).value(config);
  let channel = config.channel;
  const documentUrl = config.documentUrl;
  let binding = null;
  let epoch = 0;
  let revoked = true;
  let rekeyAllowed = false;
  let submitted = false;
  let hidden = false;
  let uncertain = false;
  let fenceRevision = 0;
  let humanRevision = 0;
  let ownWriteDepth = 0;
  let ownWriteTarget = null;
  let writeErrorRevision = 0;
  window.addEventListener(
    'error',
    () => {
      if (ownWriteDepth) writeErrorRevision++;
    },
    true,
  );
  let mutationRevision = 0;
  let inFlight = false;
  const byHuman = new WeakSet();
  const mutations = new window.MutationObserver((records) => {
    mutationRevision += records.length;
  });
  mutations.observe(doc, { subtree: true, childList: true, attributes: true, characterData: true });
  const flushMutations = () => {
    mutationRevision += mutations.takeRecords().length;
  };
  doc.addEventListener(
    'submit',
    () => {
      submitted = true;
    },
    true,
  );
  window.addEventListener(
    'pagehide',
    () => {
      hidden = true;
    },
    true,
  );
  for (const type of ['input', 'change', 'pointerdown', 'keydown']) {
    doc.addEventListener(
      type,
      (event) => {
        if (!event.isTrusted) return;
        if (
          ownWriteDepth &&
          event.target === ownWriteTarget &&
          ['input', 'change'].includes(event.type)
        )
          return;
        humanRevision++;
        if (event.target && typeof event.target === 'object') byHuman.add(event.target);
      },
      true,
    );
  }
  const observations = new Map();
  const grants = new Map();
  const requests = new Map();
  const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
  const textareaDescriptor = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value',
  );
  const handle = () =>
    [...window.crypto.getRandomValues(new Uint8Array(24))]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  const failure = (error) => ({ error, retryable: false, fallback_allowed: false });
  const readValue = (node) =>
    (node.localName === 'input' ? descriptor : textareaDescriptor).get.call(node);
  const shape = (value, keys) =>
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every(
      (key) =>
        Object.hasOwn(value, key) &&
        Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'),
    );
  const string = (value, max = 256) =>
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= max &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code === 127 || (code < 32 && ![9, 10, 13].includes(code));
    });

  // 中文注释：先检查完整语义再裁短展示；不把邻近可编辑内容或输入值当作标签。
  const sensitive =
    /password|passphrase|passwd|pwd|secret|token|api[\s_-]*key|credential|captcha|recaptcha|one[\s_-]*time|otp|\bpin\b|verification|security[\s_-]*code|auth|login|log[\s_-]*in|sign[\s_-]*in|username|user[\s_-]*name|account|consent|agree|accept[\s_-]*(terms|policy)|credit|card[\s_-]*(number|code)|\bcvv\b|\bcvc\b|iban|ssn|social[\s_-]*security|honeypot|honey[\s_-]*pot|leave[\w\s-]{0,40}(blank|empty)|do[\s_-]*not[\s_-]*fill|密码|口令|验证码|令牌|密钥|账户|账号|登录|授权|同意|条款|信用卡|身份证|留空/i;
  function textOnly(node) {
    if (node.nodeType === 3) return node.nodeValue;
    if (
      node.nodeType !== 1 ||
      node.matches(
        'input,textarea,select,button,script,style,[contenteditable]:not([contenteditable="false"])',
      )
    )
      return '';
    return [...node.childNodes].map(textOnly).join(' ');
  }
  function semantics(node) {
    const own = [
      'type',
      'name',
      'id',
      'autocomplete',
      'aria-label',
      'placeholder',
      'title',
      'aria-labelledby',
      'aria-describedby',
    ].map((name) => node.getAttribute(name) || '');
    const descriptions = ['aria-labelledby', 'aria-describedby'].flatMap((name) =>
      (node.getAttribute(name) || '')
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => {
          const target = node.getRootNode().getElementById(id);
          return target && !target.closest('[contenteditable]:not([contenteditable="false"])')
            ? textOnly(target)
            : '';
        }),
    );
    const labels = [...(node.labels || [])].map(textOnly);
    return {
      fingerprint: JSON.stringify([
        node.type,
        own,
        labels,
        descriptions,
        node.required,
        node.maxLength,
      ]),
      full: [node.type, ...own, ...labels, ...descriptions]
        .join(' ')
        .normalize('NFKC')
        .replace(/[\u200b-\u200f\u2060\ufeff]/g, ''),
      label:
        labels.join(' ') ||
        node.getAttribute('aria-label') ||
        descriptions.join(' ') ||
        node.getAttribute('placeholder') ||
        '',
    };
  }
  function eligible(node, expected = '') {
    if (
      !node.isConnected ||
      node.ownerDocument !== doc ||
      node.getRootNode() !== doc ||
      node.namespaceURI !== 'http://www.w3.org/1999/xhtml' ||
      !['input', 'textarea'].includes(node.localName)
    )
      return false;
    if (
      node.localName === 'input' &&
      !['text', 'email', 'url', 'tel', 'search'].includes(node.type)
    )
      return false;
    if (
      byHuman.has(node) ||
      node.hasAttribute('list') ||
      node.hasAttribute('aria-autocomplete') ||
      node.hasAttribute('aria-haspopup') ||
      node.hasAttribute('is') ||
      node.disabled ||
      node.matches(':disabled') ||
      node.readOnly ||
      readValue(node) !== expected ||
      node.tabIndex < 0
    )
      return false;
    if (
      node.closest(
        '[hidden],[inert],[aria-hidden="true"],[contenteditable]:not([contenteditable="false"]),[role="combobox"],[role="listbox"],[role="spinbutton"]',
      )
    )
      return false;
    if (node.getAttribute('role') && node.getAttribute('role') !== 'textbox') return false;
    for (let parent = node; parent; parent = parent.parentElement) {
      const style = window.getComputedStyle(parent);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse' ||
        style.opacity === '0' ||
        style.pointerEvents === 'none' ||
        (style.clipPath && style.clipPath !== 'none') ||
        (style.clip && style.clip !== 'auto') ||
        (['absolute', 'fixed'].includes(style.position) &&
          (Number.parseFloat(style.left) < -1000 || Number.parseFloat(style.top) < -1000)) ||
        style.contentVisibility === 'hidden'
      )
        return false;
    }
    if (
      ![...node.getClientRects()].some(
        (rect) =>
          rect.width > 1 &&
          rect.height > 1 &&
          rect.x + rect.width > 0 &&
          rect.y + rect.height > 0 &&
          rect.x < window.innerWidth &&
          rect.y < window.innerHeight,
      )
    )
      return false;
    return !sensitive.test(semantics(node).full);
  }
  function observe() {
    const fields = new Map();
    for (const node of doc.querySelectorAll('input,textarea')) {
      if (!eligible(node)) continue;
      const fieldHandle = handle();
      fields.set(fieldHandle, {
        node,
        form: node.form,
        root: node.getRootNode(),
        documentRoot: doc.documentElement,
        parent: node.parentNode,
        original: readValue(node),
        semantic: semantics(node).fingerprint,
      });
    }
    const observationHandle = handle();
    flushMutations();
    observations.set(observationHandle, {
      fields,
      epoch,
      humanRevision,
      mutationRevision,
      fenceRevision,
    });
    return {
      epoch,
      observationHandle,
      fields: [...fields].map(([fieldHandle, { node }]) => ({
        fieldHandle,
        label: semantics(node).label.slice(0, 160),
        name: node.name.slice(0, 160),
        inputType: node.localName === 'textarea' ? 'textarea' : node.type,
        required: node.required,
        maxLength: node.maxLength,
      })),
      unsupportedCount: doc.querySelectorAll('input,textarea').length - fields.size,
    };
  }

  function guard(grant, field, expected) {
    flushMutations();
    return (
      !revoked &&
      !submitted &&
      !hidden &&
      !uncertain &&
      binding &&
      window.performance.now() < grant.expiresAt &&
      grant.fenceRevision === fenceRevision &&
      grant.epoch === epoch &&
      grant.humanRevision === humanRevision &&
      grant.mutationRevision === mutationRevision &&
      window.document === doc &&
      doc.URL === documentUrl &&
      doc.documentElement === field.documentRoot &&
      field.node.form === field.form &&
      field.node.getRootNode() === field.root &&
      field.node.parentNode === field.parent &&
      eligible(field.node, expected) &&
      semantics(field.node).fingerprint === field.semantic
    );
  }

  function commit(message) {
    const { grantHandle, requestId } = message;
    const old = requests.get(requestId);
    if (old) return old.grantHandle === grantHandle ? old.result : failure('request_conflict');
    const grant = grants.get(grantHandle);
    const result = {
      epoch: grant?.epoch ?? epoch,
      requestId,
      status: 'refused',
      results: [],
      retryable: false,
      fallback_allowed: false,
    };
    requests.set(requestId, { grantHandle, result });
    if (!grant) return result;
    grants.delete(grantHandle);
    let blocked = inFlight;
    inFlight = true;
    for (const candidate of grant.candidates) {
      const field = grant.fields.get(candidate.fieldHandle);
      const { node } = field;
      let status = 'refused';
      let reason = 'stale';
      let attempted = false;
      const errorRevision = writeErrorRevision;
      try {
        if (!blocked && guard(grant, field, field.original)) {
          node.focus();
          // 中文注释：focus 可同步改 DOM；最终 guard 与原生 setter 之间无事件、IPC 或 await。
          if (guard(grant, field, field.original)) {
            attempted = true;
            ownWriteDepth++;
            ownWriteTarget = node;
            try {
              (node.localName === 'input' ? descriptor : textareaDescriptor).set.call(
                node,
                candidate.value,
              );
              node.dispatchEvent(new window.Event('input', { bubbles: true, composed: true }));
              if (errorRevision === writeErrorRevision && guard(grant, field, candidate.value)) {
                node.dispatchEvent(new window.Event('change', { bubbles: true, composed: false }));
                status =
                  errorRevision === writeErrorRevision && guard(grant, field, candidate.value)
                    ? 'confirmed'
                    : 'unknown';
              } else status = 'unknown';
            } finally {
              ownWriteDepth--;
              ownWriteTarget = null;
            }
            reason = status === 'confirmed' ? 'written' : 'post_write_changed';
          }
        }
      } catch {
        status = attempted ? 'unknown' : 'refused';
        reason = attempted ? 'write_exception' : 'guard_exception';
      }
      if (status !== 'confirmed') blocked = true;
      if (status === 'unknown') uncertain = true;
      result.results.push({ fieldHandle: candidate.fieldHandle, status, reason });
    }
    inFlight = false;
    result.status = result.results.some((item) => item.status === 'unknown')
      ? 'unknown'
      : result.results.every((item) => item.status === 'confirmed')
        ? 'confirmed'
        : 'refused';
    return result;
  }

  function dispatch(message) {
    const shapes = {
      bind: ['operation', 'binding', 'epoch', 'submissionLocked'],
      observe: ['operation'],
      prepare: ['operation', 'observationHandle', 'candidates'],
      commit: ['operation', 'grantHandle', 'requestId'],
      status: ['operation', 'requestId'],
      revoke: ['operation', 'reason'],
    };
    if (
      !message ||
      !Object.hasOwn(shapes, message.operation) ||
      !shape(message, shapes[message.operation])
    )
      return failure('invalid_command');
    if (['commit', 'status'].includes(message.operation) && !string(message.requestId))
      return failure('invalid_request');
    if (message.operation === 'commit' && !string(message.grantHandle))
      return failure('invalid_grant');
    if (message.operation === 'bind') {
      if (
        !shape(message.binding, ['product', 'source', 'item', 'submissionUrl']) ||
        !Object.values(message.binding).every((value) => string(value, 2048)) ||
        message.binding.submissionUrl !== documentUrl ||
        typeof message.submissionLocked !== 'boolean'
      )
        return failure('invalid_binding');
      if (binding && !revoked) {
        if (
          epoch === message.epoch &&
          JSON.stringify(binding) === JSON.stringify(message.binding)
        ) {
          if (message.submissionLocked) submitted = true;
          return { bound: true, epoch };
        }
        return failure('revoke_required');
      }
      if (!Number.isSafeInteger(message.epoch) || message.epoch <= epoch)
        return failure('invalid_epoch');
      if (doc.URL !== documentUrl) return failure('document_changed');
      binding = { ...message.binding };
      epoch = message.epoch;
      revoked = false;
      rekeyAllowed = false;
      if (message.submissionLocked) submitted = true;
      return { bound: true, epoch };
    }
    if (message.operation === 'status')
      return requests.get(message.requestId)?.result || failure('request_unknown');
    if (message.operation === 'revoke') {
      if (!string(message.reason)) return failure('invalid_reason');
      revoked = true;
      rekeyAllowed = true;
      fenceRevision++;
      return { revoked: true, epoch };
    }
    if (message.operation === 'commit') return commit(message);
    if (!binding || revoked) return failure('unbound');
    if (submitted || hidden || uncertain) return failure('document_fenced');
    if (doc.URL !== documentUrl) return failure('document_changed');
    if (message.operation === 'observe') return observe();
    if (message.operation === 'prepare') {
      const observation = observations.get(message.observationHandle);
      if (!observation) return failure('observation_unknown');
      if (
        !Array.isArray(message.candidates) ||
        message.candidates.length < 1 ||
        message.candidates.length > 64
      )
        return failure('invalid_candidates');
      const seen = new Set();
      let total = 0;
      for (const candidate of message.candidates) {
        if (
          !shape(candidate, ['fieldHandle', 'value']) ||
          !string(candidate.fieldHandle) ||
          !observation.fields.has(candidate.fieldHandle) ||
          seen.has(candidate.fieldHandle) ||
          !string(candidate.value, 8192)
        )
          return failure('invalid_candidate');
        const field = observation.fields.get(candidate.fieldHandle);
        if (field.node.maxLength >= 0 && candidate.value.length > field.node.maxLength)
          return failure('value_too_long');
        total += candidate.value.length;
        if (total > 32768) return failure('values_too_long');
        seen.add(candidate.fieldHandle);
      }
      const grantHandle = handle();
      const grant = {
        ...observation,
        candidates: message.candidates.map(({ fieldHandle, value }) => ({ fieldHandle, value })),
        expiresAt: window.performance.now() + 5000,
      };
      if (
        !grant.candidates.every((candidate) =>
          guard(
            grant,
            grant.fields.get(candidate.fieldHandle),
            grant.fields.get(candidate.fieldHandle).original,
          ),
        )
      )
        return failure('observation_stale');
      grants.set(grantHandle, grant);
      return { grantHandle, epoch };
    }
    return failure('invalid_command');
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (
      sender?.id !== chrome.runtime.id ||
      sender.tab ||
      message?.type !== 'fbl.product_fill' ||
      message.channel !== channel
    )
      return;
    try {
      if (!shape(message, ['type', 'channel', 'command'])) {
        sendResponse(failure('invalid_envelope'));
        return;
      }
      sendResponse(dispatch(message.command));
    } catch {
      sendResponse(failure('authority_error'));
    }
  });
  // 中文注释：仅同一扩展的 isolated 世界可调用 rekey；旧闭包先撤权，所有单调事实和墓碑保留。
  const rekey = (next) => {
    if (next.documentUrl !== documentUrl || doc.URL !== documentUrl)
      return { installed: false, error: 'document_changed' };
    if (next.channel === channel) return { installed: true, url: doc.URL };
    if (!revoked || !rekeyAllowed || inFlight)
      return { installed: false, error: 'revoke_required' };
    channel = next.channel;
    rekeyAllowed = false;
    fenceRevision++;
    return { installed: true, url: doc.URL };
  };
  Object.defineProperty(globalThis, marker, { value: rekey, configurable: false, writable: false });
  return { installed: true, url: doc.URL };
}
