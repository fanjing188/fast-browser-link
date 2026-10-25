import test from 'node:test';
import assert from 'node:assert/strict';
import { Executor } from '../../native-extension/core.mjs';
import { readFile } from 'node:fs/promises';

test('产品worker入口使用静态依赖，首次派发不触发不受支持的动态import', async () => {
  const source = await readFile(
    new URL('../../native-extension/core.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /import\s*\{\s*ProductFill\s*\}\s*from\s*['"]\.\/product-fill\.mjs['"]/);
  assert.match(
    source,
    /import\s*\{\s*installProductFillAuthority\s*\}\s*from\s*['"]\.\/product-fill-content\.mjs['"]/,
  );
  assert.doesNotMatch(source, /import\(['"]\.\/product-fill/);
});

function fixture() {
  const executor = new Executor({ tabs: {} });
  const task = {
    id: 'product-task',
    generation: 1,
    executionLane: 'product_fill',
    tabIds: new Set([17]),
    agentTabs: new Set(),
    policy: { activeMode: 'full', modeGeneration: 1 },
  };
  executor.tasks.set(task.id, task);
  executor.leases.set(17, task.id);
  return {
    executor,
    task,
    params: { taskId: task.id, generation: 1, modeGeneration: 1, tabId: 17 },
  };
}

test('产品选页在attach时冻结真实文档，审批不能接受同URL替换文档', async () => {
  const tab = { id: 17, url: 'https://example.test/form', incognito: false };
  let documentId = 'selected-document';
  const executor = new Executor({
    tabs: { query: async () => [tab], get: async () => tab },
    scripting: {
      executeScript: async (spec) => {
        if (spec.target.documentIds && !spec.target.documentIds.includes(documentId))
          throw Error('No document with ID');
        return [{ frameId: 0, documentId, result: tab.url }];
      },
    },
  });
  executor.restoreOverlay = async () => {};
  const attachment = await executor.selectExistingTab({
    url: tab.url,
    incognito: false,
    productFill: true,
  });
  assert.equal(attachment.documentId, 'selected-document');
  documentId = 'replacement-document';
  await assert.rejects(
    executor.installApproval(
      {
        id: 'product',
        generation: 1,
        allowedOrigins: ['https://example.test'],
        tabIds: [17],
        executionLane: 'product_fill',
        attachment,
      },
      () => true,
    ),
  );
  assert.equal(executor.leases.size, 0);
  documentId = 'selected-document';
  const approved = await executor.installApproval(
    {
      id: 'product',
      generation: 1,
      allowedOrigins: ['https://example.test'],
      tabIds: [17],
      executionLane: 'product_fill',
      attachment,
    },
    () => true,
  );
  assert.equal(approved.attachment.documentId, 'selected-document');
  assert.equal(executor.leases.get(17), 'product');
});

test('产品租约不允许通用动作绕过业务保护', async () => {
  const { executor, params } = fixture();
  let performed = 0;
  executor.performRecovering = async () => {
    performed++;
    return { filled: true };
  };
  await assert.rejects(
    executor.execute({ ...params, action: 'fill', selector: '#name', text: 'x' }),
    /PRODUCT_LANE_REQUIRED/,
  );
  assert.equal(performed, 0);
});

test('产品文档校验返回错ID或发布租约前换页都拒绝审批', async () => {
  for (const swappedBeforeLease of [false, true]) {
    const tab = { id: 17, url: 'https://example.test/form', incognito: false };
    let checked = 0;
    const executor = new Executor({
      tabs: { get: async () => tab },
      scripting: {
        executeScript: async () => {
          checked++;
          return [
            {
              frameId: 0,
              documentId:
                swappedBeforeLease && checked === 1 ? 'selected-document' : 'replacement-document',
              result: tab.url,
            },
          ];
        },
      },
    });
    executor.restoreOverlay = async () => {};
    await assert.rejects(
      executor.installApproval(
        {
          id: 'product',
          generation: 1,
          allowedOrigins: ['https://example.test'],
          tabIds: [17],
          executionLane: 'product_fill',
          attachment: { tabId: 17, url: tab.url, documentId: 'selected-document' },
        },
        () => true,
      ),
      /ATTACH_UNAVAILABLE/,
    );
    assert.equal(executor.leases.size, 0);
    assert.equal(executor.tasks.size, 0);
  }
});

test('产品租约拒绝原始CDP、脚本与私有凭据旁路', async () => {
  const { executor, task, params } = fixture();
  await assert.rejects(executor.gateway('browser.cdp_version', params), /PRODUCT_LANE_REQUIRED/);
  assert.throws(() => executor.pageRuntime.assertAccess(task), /PRODUCT_LANE_REQUIRED/);
  await assert.rejects(
    executor.vault.scope({ ...params, instanceId: 'instance' }),
    /PRODUCT_LANE_REQUIRED/,
  );
  await assert.rejects(executor.credentials(params), /PRODUCT_LANE_REQUIRED/);
});

test('专用动作只路由到FBL产品保护器，普通任务不能获得同名执行资格', async () => {
  const { executor, task, params } = fixture();
  let called = 0;
  executor.productFill = {
    execute: async (values) => {
      called++;
      assert.equal(values.command.operation, 'observe');
      return { observed: true };
    },
  };
  assert.deepEqual(
    await executor.execute({
      ...params,
      action: 'product.fill',
      command: { operation: 'observe' },
    }),
    { observed: true },
  );
  assert.equal(called, 1);
  delete task.executionLane;
  await assert.rejects(
    executor.execute({ ...params, action: 'product.fill', command: { operation: 'observe' } }),
    /PRODUCT_LANE_REQUIRED/,
  );
  assert.equal(called, 1);
});

test('人工接管先确认页面产品许可撤销，未确认不放开遮罩', async () => {
  const { executor, task } = fixture();
  task.semanticBindings = new Map();
  task.frameRefs = new Map();
  task.interactionRefs = new Map();
  task.interactions = new Map();
  const states = [];
  executor.syncTaskOverlays = async (_task, state) => {
    states.push(state);
  };
  executor.syncPreveil = async () => {};
  executor.productFill = {
    revoke: async () => {
      states.push('revoke');
      throw Error('PRODUCT_REVOCATION_UNKNOWN');
    },
  };
  await assert.rejects(executor.pause(task.id, task.generation), /PRODUCT_REVOCATION_UNKNOWN/);
  assert.equal(task.pauseRequested, true);
  assert.notEqual(task.paused, true);
  assert.equal(states.includes('paused'), false);
  assert.equal(states.includes('revoke'), true);
});

test('产品任务释放同步撤销页面许可，撤销未知不能伪报清理成功', async () => {
  const { executor, task } = fixture();
  task.policy = executor.policy.createState({
    browserInstanceId: 'instance',
    taskId: task.id,
    ownerId: 'owner',
    sessionId: 'session',
    taskGeneration: 1,
    connectionGeneration: 1,
  });
  task.allowedOrigins = [];
  task.overlays = new Map();
  task.semanticBindings = new Map();
  task.frameRefs = new Map();
  task.interactionRefs = new Map();
  task.frameSessions = new Map();
  task.interactions = new Map();
  task.childHighlights = new Map();
  task.pendingInteractionProbes = new Set();
  task.pendingInteractionCleanups = new Set();
  const reasons = [];
  executor.closeTabResources = async () => ({ cleanupState: 'succeeded' });
  executor.productFill = {
    revoke: async (_task, reason) => {
      reasons.push(reason);
      throw Error('PRODUCT_REVOCATION_UNKNOWN');
    },
  };
  const result = await executor.release({ taskId: task.id, generation: 1, closeAgentTabs: false });
  assert.deepEqual(reasons, ['released']);
  assert.equal(result.cleanupState, 'unknown');
});
