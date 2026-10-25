const denied = (code) => Object.assign(Error(code), { preDispatch: true });
const operations = new Set(['bind', 'observe', 'prepare', 'commit', 'status', 'revoke']);

// 中文注释：页面权威属于FBL自己的扩展世界，通用脚本和模型参数拿不到私有通道。
export class ProductFill {
  constructor(executor, installAuthority) {
    this.executor = executor;
    this.installAuthority = installAuthority;
    this.pages = new WeakMap();
    this.fenced = new WeakSet();
    this.revocations = new WeakMap();
    this.unknown = new WeakSet();
  }

  guard(task, params, rebind = null) {
    const executor = this.executor;
    executor.check(task, params);
    if (task.executionLane !== 'product_fill') throw denied('PRODUCT_LANE_REQUIRED');
    if (typeof task.attachment?.documentId !== 'string' || !task.attachment.documentId)
      throw denied('PRODUCT_DOCUMENT_CHANGED');
    if (this.unknown.has(task) && !['status', 'revoke'].includes(params.command?.operation))
      throw denied('PRODUCT_OUTCOME_UNKNOWN');
    if (this.fenced.has(task) && (!rebind?.confirmed || this.revocations.get(task) !== rebind))
      throw denied('PRODUCT_AUTHORITY_REVOKED');
    if (task.paused || task.pauseRequested) throw denied('TASK_PAUSED');
    if (task.policy?.activeMode !== 'full' || task.policy.modeGeneration !== params.modeGeneration)
      throw denied('PRODUCT_AUTHORITY_REVOKED');
    if (
      executor.leases.get(params.tabId) !== task.id ||
      !task.tabIds.has(params.tabId) ||
      task.attachment?.tabId !== params.tabId
    )
      throw denied('PRODUCT_SCOPE_CHANGED');
  }

  async page(task, params, guard) {
    guard();
    const api = this.executor.api;
    const documentGeneration = this.executor.docs.get(params.tabId) || 0;
    const tab = await api.tabs.get(params.tabId);
    guard();
    if (documentGeneration !== (this.executor.docs.get(params.tabId) || 0))
      throw denied('PRODUCT_DOCUMENT_CHANGED');
    if (tab.url !== task.attachment.url || (tab.pendingUrl && tab.pendingUrl !== tab.url))
      throw denied('PRODUCT_DOCUMENT_CHANGED');
    let page = this.pages.get(task);
    if (!page) {
      const channel = crypto.randomUUID();
      const result = await api.scripting.executeScript({
        target: { tabId: params.tabId, documentIds: [task.attachment.documentId] },
        world: 'ISOLATED',
        func: this.installAuthority,
        args: [{ channel, documentUrl: tab.url }],
      });
      if (
        result.length !== 1 ||
        result[0].frameId !== 0 ||
        typeof result[0].documentId !== 'string' ||
        !result[0].documentId ||
        result[0].documentId !== task.attachment.documentId ||
        result[0].result?.installed !== true ||
        result[0].result.url !== tab.url
      )
        throw denied('PRODUCT_INSTALL_UNCONFIRMED');
      page = {
        channel,
        documentId: result[0].documentId,
        tabId: params.tabId,
        url: tab.url,
        documentGeneration,
      };
      this.pages.set(task, page);
      // 中文注释：注入已发生，先保存精确通道供暂停/释放撤销，再复核准入。
      guard();
      if (documentGeneration !== (this.executor.docs.get(params.tabId) || 0))
        throw denied('PRODUCT_DOCUMENT_CHANGED');
      const current = await api.tabs.get(params.tabId);
      guard();
      if (current.url !== page.url || (current.pendingUrl && current.pendingUrl !== current.url))
        throw denied('PRODUCT_DOCUMENT_CHANGED');
    }
    if (
      page.tabId !== params.tabId ||
      page.url !== tab.url ||
      page.documentGeneration !== (this.executor.docs.get(params.tabId) || 0)
    )
      throw denied('PRODUCT_DOCUMENT_CHANGED');
    return page;
  }

  send(page, command) {
    return this.executor.api.tabs.sendMessage(
      page.tabId,
      {
        type: 'fbl.product_fill',
        channel: page.channel,
        command,
      },
      { documentId: page.documentId },
    );
  }

  async execute(params) {
    params = structuredClone(params);
    const task = this.executor.tasks.get(params.taskId);
    const operation = params.command?.operation;
    const rebind = ['bind', 'revoke', 'status'].includes(operation)
      ? this.revocations.get(task)
      : null;
    const guard = () => this.guard(task, params, rebind);
    guard();
    const command = params.command;
    if (
      !command ||
      typeof command !== 'object' ||
      Array.isArray(command) ||
      !operations.has(command.operation)
    )
      throw denied('PRODUCT_INVALID_COMMAND');
    return this.executor.taskBarrier(task.id, false, () =>
      this.executor.lock(params.tabId, async () => {
        const page = await this.page(task, params, guard);
        guard();
        try {
          const result = await this.send(page, {
            ...command,
            ...(command.operation === 'commit' ? { requestId: params.requestId } : {}),
          });
          guard();
          if (!result || typeof result !== 'object' || Array.isArray(result) || result.error)
            throw Error('invalid product receipt');
          if (operation === 'commit' && result.status === 'unknown') this.unknown.add(task);
          if (rebind && operation === 'bind' && result.bound === true) {
            this.fenced.delete(task);
            this.revocations.delete(task);
          }
          return result;
        } catch {
          if (operation === 'commit') this.unknown.add(task);
          // 中文注释：消息已派发后，正文、异常和缺失回执均不能推断未写入，更不能重发。
          throw Object.assign(Error('PRODUCT_OUTCOME_UNKNOWN'), {
            outcomeUnknown: true,
            preDispatch: false,
          });
        }
      }),
    );
  }

  revoke(task, reason) {
    if (!task || task.executionLane !== 'product_fill') return Promise.resolve();
    this.fenced.add(task);
    const revocation = { confirmed: false };
    this.revocations.set(task, revocation);
    return this.executor.taskBarrier(task.id, true, () => {
      const page = this.pages.get(task);
      if (!page) {
        revocation.confirmed = true;
        return { revoked: true };
      }
      return this.executor.lock(page.tabId, async () => {
        const receipt = await this.send(page, { operation: 'revoke', reason });
        if (receipt?.revoked !== true) throw Error('PRODUCT_REVOCATION_UNKNOWN');
        revocation.confirmed = true;
        return receipt;
      });
    });
  }
}
