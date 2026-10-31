const fail = (code) => Object.assign(Error(code), { code });
const workOperations = new Set([
  'tables_read',
  'search_read',
  'trends_read',
  'report_inspect',
  'query_submit',
  'table_advance',
  'navigate',
  'snapshot',
  'click',
  'fill',
]);
const observationMethods = {
  list_pages: 'listPages',
  select_current: 'select',
  capture_material: 'capture',
  capture_tables: 'tables',
  table_confirmation_begin: 'beginConfirmation',
  table_confirmation_control: 'controlConfirmation',
};

// 中文注释：固定产品操作进入同一Native账本；产品不能提供owner/tabId或任意CDP/源码。
export class AssistController {
  constructor(observation, bridge, consent) {
    this.observation = observation;
    this.bridge = bridge;
    this.consent = consent;
    this.tables = new Map();
    this.resources = new Map();
    this.policies = new Map();
  }
  async dispatch(session, operation, params) {
    if (operation.startsWith('observation.')) {
      const method = observationMethods[operation.slice('observation.'.length)];
      if (!method) throw fail('ASSIST_INVALID_REQUEST');
      return this.observation[method](session, params);
    }
    const bridge = this.bridge();
    if (!bridge) throw fail('ASSIST_OFFLINE');
    const scope = { productId: session.productId, session: session.session };
    if (operation === 'work.resource_bind') {
      const { policy, ...resource } = params;
      const result = await bridge.request('extension.assist.work.resource_bind', {
        ...resource,
        ...scope,
      });
      if (policy)
        this.resources.set(result.resourceHandle, { session, policy: structuredClone(policy) });
      return result;
    }
    if (operation === 'work.resource_revoke')
      return bridge.request('extension.assist.work.resource_revoke', { ...params, ...scope });
    if (operation === 'work.open') {
      const created = await bridge.request('extension.assist.work.open', { ...scope, ...params });
      if (!created?.workHandle) throw fail('ASSIST_INVALID_RECEIPT');
      await this.consent.synchronize(bridge);
      const result = await bridge.request('extension.assist.work.get', {
        ...scope,
        workHandle: created.workHandle,
      });
      const resource = this.resources.get(params.resourceHandle);
      if (!resource || resource.session !== session) return result;
      const policyHandle = crypto.randomUUID();
      this.policies.set(policyHandle, {
        session,
        workHandle: created.workHandle,
        policy: resource.policy,
      });
      return {
        ...result,
        policyHandles: { report: policyHandle },
        ...(resource.policy.query ? { queryHandle: policyHandle } : {}),
      };
    }
    if (operation === 'work.status')
      return bridge.request('extension.assist.work.get', { ...scope, ...params });
    if (operation === 'work.close')
      return bridge.request('extension.assist.work.close', { ...scope, ...params });
    const name = operation.startsWith('work.') ? operation.slice(5) : null;
    if (!workOperations.has(name)) throw fail('ASSIST_INVALID_REQUEST');
    const { workHandle, requestId = crypto.randomUUID(), ...args } = params;
    if (name === 'report_inspect' || name === 'query_submit') {
      const policy = this.policies.get(args.policyHandle || args.queryHandle);
      if (!policy || policy.session !== session || policy.workHandle !== workHandle)
        throw fail('ASSIST_POLICY_UNAVAILABLE');
      delete args.policyHandle;
      delete args.queryHandle;
      const phase = args.phase ?? 'report';
      delete args.phase;
      if (!['query', 'report'].includes(phase) || (phase === 'query' && !policy.policy.query))
        throw fail('ASSIST_POLICY_UNAVAILABLE');
      Object.assign(
        args,
        name === 'report_inspect'
          ? {
              ready_selectors:
                phase === 'query' ? [policy.policy.query.root] : policy.policy.ready_selectors,
              stop_text: policy.policy.stop_text,
            }
          : policy.policy.query,
      );
    }
    if (name === 'tables_read') {
      args.minimumRows ??= 1;
      args.headers ??= [];
      args.selectors ??= [];
    }
    if (name === 'table_advance') {
      const table = this.tables.get(args.tableHandle);
      if (!table || table.session !== session || table.workHandle !== workHandle)
        throw fail('ASSIST_TABLE_UNAVAILABLE');
      delete args.tableHandle;
      args.headers = table.headers;
    }
    let result = await bridge.request('extension.assist.work.run', {
      ...scope,
      workHandle,
      requestId,
      operation: name,
      arguments: args,
    });
    if (
      ['tables_read', 'search_read', 'trends_read', 'report_inspect', 'table_advance'].includes(
        name,
      )
    ) {
      if (result?.ok === false || result?.outcomeUnknown === true)
        throw fail('ASSIST_OUTCOME_UNKNOWN');
      if (result?.ok === true && Object.hasOwn(result, 'value')) result = result.value;
    }
    if (name === 'tables_read' && Array.isArray(result?.tables)) {
      for (const [key, table] of this.tables)
        if (table.session === session && table.workHandle === workHandle) this.tables.delete(key);
      return {
        ...result,
        tables: result.tables.map((table) => {
          const tableHandle = crypto.randomUUID();
          this.tables.set(tableHandle, { session, workHandle, headers: table.headers });
          return { ...table, tableHandle };
        }),
      };
    }
    return result;
  }
  async revoke(session) {
    // 中文注释：本地准入先关闭；Native返回精确清理回执后才允许删除登记。
    this.observation.revoke(session);
    for (const [key, table] of this.tables) if (table.session === session) this.tables.delete(key);
    for (const [key, record] of this.resources)
      if (record.session === session) this.resources.delete(key);
    for (const [key, record] of this.policies)
      if (record.session === session) this.policies.delete(key);
    const bridge = this.bridge();
    if (!bridge) throw fail('ASSIST_REVOCATION_UNKNOWN');
    return bridge.request('extension.assist.work.session_close', {
      productId: session.productId,
      session: session.session,
    });
  }
}
