const validId = (value) =>
  typeof value === 'string' && value.length === 32 && /^[a-p]{32}$/.test(value);

const copy = {
  zh: {
    title: '产品连接',
    intro: '在本机将已加载的 Fast-Backlink 连接到 FBL。',
    label: 'Fast-Backlink 扩展 ID',
    help: '从 Fast-Backlink 侧栏的连接区复制当前已加载的扩展 ID，再粘贴到这里。',
    rule: 'ID 必须是 32 位小写字母 a–p；不要填写名称或网址。',
    identity: '名称不代表身份。扩展 ID 变化后，需要重新配对。',
    pair: '配对产品',
    registry: '已登记产品',
    refresh: '核对状态',
    reconnect: '重新连接',
    unpair: '解除配对',
    unpairing: '正在解除配对…',
    unpaired: '已解除配对。该产品后续不能继续控制。',
    unpairHelp: '解除配对会停止该产品后续控制，保留原页面和已填数据。不保证取消已派发的操作。',
    loading: '读取中…',
    empty: '尚未配对产品。',
    ready: '登记状态已核对。',
    connected: '已连接',
    offline: '离线',
    unchecked: '待核对',
    invalid: '请核对扩展 ID：必须是 32 位小写字母 a–p。',
    pairing: '正在配对…',
    paired: '产品已登记，请以列表中的连接状态为准。',
    readFailed: '未能核对连接状态。请检查扩展后手动核对状态。',
    unknown: '结果未确认，未自动重发。请先核对状态，再决定是否操作。',
    errors: {
      PRODUCT_INVALID_ID: '扩展 ID 无效。请核对从 Fast-Backlink 复制的 ID。',
      PRODUCT_CAPACITY: '登记数量已满。请核对列表，解除不再使用的产品后再配对。',
      PRODUCT_OFFLINE: '产品或 FBL 当前离线。请检查扩展是否已加载，再核对状态。',
      PRODUCT_ACCESS_REQUIRED: '尚未允许本机连接。请检查 FBL 弹窗中的连接设置，再核对状态。',
      PRODUCT_INVALID_REGISTRY: '登记信息无法读取。请检查 FBL 扩展，再核对状态。',
      PRODUCT_REVOCATION_UNKNOWN:
        '解除配对尚未确认，登记项已保留。请检查 FBL 本机连接后核对状态；不会自动重发。',
      PRODUCT_UNTRUSTED_UI: '此页面未获配对权限。请检查地址，从 FBL 扩展打开产品连接页面。',
    },
  },
  en: {
    title: 'Product connections',
    intro: 'Connect your loaded Fast-Backlink extension to FBL on this device.',
    label: 'Fast-Backlink extension ID',
    help: 'Copy the currently loaded extension ID from the connection area in the Fast-Backlink sidebar, then paste it here.',
    rule: 'Use exactly 32 lowercase letters a–p, not a name or URL.',
    identity: 'A name is not an identity. If the extension ID changes, pair it again.',
    pair: 'Pair product',
    registry: 'Registered products',
    refresh: 'Check status',
    reconnect: 'Reconnect',
    unpair: 'Unpair',
    unpairing: 'Unpairing…',
    unpaired: 'Product unpaired. Subsequent control from this product is blocked.',
    unpairHelp:
      'Unpairing stops this product’s subsequent control and keeps the original page and entered data. It may not cancel actions already dispatched.',
    loading: 'Reading…',
    empty: 'No products paired yet.',
    ready: 'Registry checked.',
    connected: 'Connected',
    offline: 'Offline',
    unchecked: 'Not confirmed',
    invalid: 'Check the extension ID: use exactly 32 lowercase letters a–p.',
    pairing: 'Pairing…',
    paired: 'Product registered. Check the connection status in the list.',
    readFailed:
      'Could not check connection status. Check the extensions, then check status manually.',
    unknown:
      'Outcome not confirmed; nothing was retried automatically. Check status before deciding what to do next.',
    errors: {
      PRODUCT_INVALID_ID: 'Invalid extension ID. Check the ID copied from Fast-Backlink.',
      PRODUCT_CAPACITY:
        'The registry is full. Check the list and unpair an unused product before pairing another.',
      PRODUCT_OFFLINE:
        'The product or FBL is offline. Check that both extensions are loaded, then check status.',
      PRODUCT_ACCESS_REQUIRED:
        'Local connection is not allowed yet. Check connection settings in the FBL popup, then check status.',
      PRODUCT_INVALID_REGISTRY:
        'The registry could not be read. Check the FBL extension, then check status.',
      PRODUCT_REVOCATION_UNKNOWN:
        'Revocation is not confirmed; the registration is retained. Check the FBL local connection and status. Nothing was retried.',
      PRODUCT_UNTRUSTED_UI:
        'This page cannot pair products. Check the address and open the product connections page from the FBL extension.',
    },
  },
};

function registryReceipt(response) {
  if (!response || typeof response !== 'object') throw Error('PRODUCT_INVALID_RECEIPT');
  if (Object.hasOwn(response, 'error'))
    throw Error(typeof response.error === 'string' ? response.error : 'PRODUCT_INVALID_RECEIPT');
  const entries = response.result;
  if (
    !Array.isArray(entries) ||
    entries.length > 4 ||
    entries.some(
      (entry) => !entry || !validId(entry.extensionId) || typeof entry.connected !== 'boolean',
    ) ||
    new Set(entries.map((entry) => entry.extensionId)).size !== entries.length
  )
    throw Error('PRODUCT_INVALID_RECEIPT');
  return entries;
}

export function mountProductConnections(doc, runtime) {
  const language = doc.defaultView.navigator.language;
  const t = language.toLowerCase().startsWith('zh') ? copy.zh : copy.en;
  doc.documentElement.lang = t === copy.zh ? 'zh-CN' : 'en';
  doc.title = `${t.title} · Fast-browser-link`;
  for (const element of doc.querySelectorAll('[data-copy]'))
    element.textContent = t[element.dataset.copy];
  const status = doc.querySelector('#registry-status');
  const input = doc.querySelector('#extension-id');
  const feedback = doc.querySelector('#action-status');
  const list = doc.querySelector('#connections');
  list.setAttribute('aria-label', t.registry);
  let busy = false;

  function setBusy(value) {
    busy = value;
    for (const control of doc.querySelectorAll('button, input')) control.disabled = value;
    doc.querySelector('#pair-form').setAttribute('aria-busy', String(value));
  }

  function announce(message, state = 'success') {
    feedback.hidden = false;
    feedback.dataset.state = state;
    feedback.textContent = message;
  }

  function markUnconfirmed() {
    for (const state of list.querySelectorAll('.product-state')) {
      state.textContent = t.unchecked;
      delete state.dataset.connected;
    }
  }

  function render(entries) {
    list.replaceChildren();
    for (const entry of entries) {
      const row = doc.createElement('li');
      row.className = 'product-row';
      row.dataset.extensionId = entry.extensionId;
      const id = doc.createElement('code');
      id.className = 'product-id';
      id.textContent = entry.extensionId;
      const state = doc.createElement('span');
      state.className = 'product-state';
      state.dataset.connected = String(entry.connected);
      state.textContent = entry.connected ? t.connected : t.offline;
      const actions = doc.createElement('div');
      actions.className = 'product-actions';
      const reconnect = doc.createElement('button');
      reconnect.type = 'button';
      reconnect.dataset.action = 'reconnect';
      reconnect.textContent = t.reconnect;
      reconnect.setAttribute('aria-label', `${t.reconnect} ${entry.extensionId}`);
      reconnect.addEventListener('click', () => void pair(entry.extensionId, 'reconnect'));
      const unpair = doc.createElement('button');
      unpair.type = 'button';
      unpair.className = 'danger';
      unpair.dataset.action = 'unpair';
      unpair.textContent = t.unpair;
      unpair.setAttribute('aria-label', `${t.unpair} ${entry.extensionId}`);
      unpair.setAttribute('aria-describedby', 'unpair-help');
      unpair.addEventListener('click', () => void pair(entry.extensionId, 'unpair'));
      actions.append(reconnect, unpair);
      row.append(id, state, actions);
      list.append(row);
    }
    status.dataset.state = 'ready';
    status.textContent = entries.length ? t.ready : t.empty;
  }

  doc.querySelector('#pair-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    if (!validId(input.value)) {
      input.setAttribute('aria-invalid', 'true');
      announce(t.invalid, 'error');
      input.focus();
      return;
    }
    input.removeAttribute('aria-invalid');
    await pair(input.value);
  });

  async function pair(extensionId, action) {
    if (busy) return;
    const removing = action === 'unpair';
    let succeeded = false;
    setBusy(true);
    announce(removing ? t.unpairing : t.pairing, 'loading');
    try {
      const response = await runtime.sendMessage({
        type: removing ? 'product_unpair' : 'product_pair',
        extensionId,
      });
      const entries = registryReceipt(response);
      const present = entries.some((entry) => entry.extensionId === extensionId);
      if (removing ? present : !present) throw Error('PRODUCT_INVALID_RECEIPT');
      render(entries);
      succeeded = true;
      announce(removing ? t.unpaired : t.paired);
    } catch (error) {
      // 中文注释：只显示受控文案；未知回执和传输错误均不自动重发写操作。
      markUnconfirmed();
      announce(
        Object.hasOwn(t.errors, error?.message) ? t.errors[error.message] : t.unknown,
        'error',
      );
    } finally {
      setBusy(false);
      (action && !(removing && succeeded)
        ? list.querySelector(`[data-extension-id="${extensionId}"] [data-action="${action}"]`)
        : input
      )?.focus();
    }
  }

  const refresh = doc.querySelector('#refresh-button');
  refresh.addEventListener('click', () => void readStatus(true));
  async function readStatus(restoreFocus = false) {
    if (busy) return;
    setBusy(true);
    status.textContent = t.loading;
    status.dataset.state = 'loading';
    markUnconfirmed();
    try {
      const response = await runtime.sendMessage({ type: 'product_connections' });
      render(registryReceipt(response));
    } catch {
      status.dataset.state = 'error';
      status.textContent = t.readFailed;
    } finally {
      setBusy(false);
      if (restoreFocus) refresh.focus();
    }
  }
  void readStatus();
}

if (typeof document !== 'undefined' && globalThis.chrome?.runtime)
  mountProductConnections(document, chrome.runtime);
