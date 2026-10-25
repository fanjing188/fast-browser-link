import test from 'node:test';
import assert from 'node:assert/strict';
import { ProductFill } from '../../native-extension/product-fill.mjs';

function setup() {
  const calls = [];
  const task = {
    id: 'task',
    generation: 1,
    executionLane: 'product_fill',
    policy: { activeMode: 'full', modeGeneration: 1 },
    attachment: { tabId: 17, url: 'https://example.test/form', documentId: 'document-1' },
    tabIds: new Set([17]),
  };
  const executor = {
    tasks: new Map([[task.id, task]]),
    leases: new Map([[17, task.id]]),
    docs: new Map(),
    check(t, p) {
      if (this.tasks.get(t?.id) !== t || t.generation !== p.generation || t.revoked)
        throw Error('stale generation');
    },
    taskBarrier: async (_id, _write, fn) => fn(),
    lock: async (_id, fn) => fn(),
    api: {
      tabs: {
        get: async () => ({ id: 17, url: task.attachment.url }),
        sendMessage: async (id, message, target) => {
          calls.push({ id, message, target });
          return message.command.operation === 'revoke'
            ? { revoked: true, epoch: 1 }
            : message.command.operation === 'bind'
              ? { bound: true, epoch: message.command.epoch }
              : { epoch: 1, operation: message.command.operation };
        },
      },
      scripting: {
        executeScript: async (spec) => {
          calls.push({ install: spec });
          return [
            {
              frameId: 0,
              documentId: 'document-1',
              result: { installed: true, url: task.attachment.url },
            },
          ];
        },
      },
    },
  };
  const fill = new ProductFill(executor, () => {});
  const params = {
    taskId: task.id,
    generation: 1,
    modeGeneration: 1,
    tabId: 17,
    action: 'product.fill',
    requestId: 'request-1',
    command: { operation: 'observe' },
  };
  return { fill, executor, task, params, calls };
}

test('产品命令只在真实原页文档内注入并精确documentId派发', async () => {
  const { fill, params, calls } = setup();
  assert.deepEqual(await fill.execute(params), { epoch: 1, operation: 'observe' });
  assert.equal(calls[0].install.world, 'ISOLATED');
  assert.deepEqual(calls[0].install.target, { tabId: 17, documentIds: ['document-1'] });
  assert.deepEqual(calls[1].target, { documentId: 'document-1' });
  assert.equal(calls[1].message.type, 'fbl.product_fill');
  assert.equal(calls[1].message.channel, calls[0].install.args[0].channel);
  await fill.execute({ ...params, requestId: 'request-2' });
  assert.equal(calls.filter((row) => row.install).length, 1);
});

test('attach后首次bind前同URL换文档不能给新文档安装旧业务权威', async () => {
  const { fill, executor, params, calls } = setup();
  executor.api.scripting.executeScript = async (spec) => {
    calls.push({ install: spec });
    if (spec.target.documentIds?.[0] === 'document-1') throw Error('No document with ID');
    return [
      {
        frameId: 0,
        documentId: 'replacement-document',
        result: { installed: true, url: 'https://example.test/form' },
      },
    ];
  };
  await assert.rejects(fill.execute({ ...params, command: { operation: 'bind' } }));
  assert.equal(calls.filter((call) => call.message).length, 0);
});

test('注入回执不能用另一个文档身份替代选页时的身份', async () => {
  const { fill, executor, params, calls } = setup();
  executor.api.scripting.executeScript = async () => [
    {
      frameId: 0,
      documentId: 'replacement-document',
      result: { installed: true, url: 'https://example.test/form' },
    },
  ];
  await assert.rejects(fill.execute(params), /PRODUCT_INSTALL_UNCONFIRMED/);
  assert.equal(calls.filter((call) => call.message).length, 0);
});

test('普通任务、失效租约和异步换页都不能安装或派发产品命令', async () => {
  for (const kind of ['ordinary', 'lease', 'navigation']) {
    const { fill, executor, task, params, calls } = setup();
    if (kind === 'ordinary') delete task.executionLane;
    if (kind === 'lease') executor.leases.delete(17);
    if (kind === 'navigation')
      executor.api.tabs.get = async () => ({ url: 'https://example.test/other' });
    await assert.rejects(fill.execute(params));
    assert.equal(calls.length, 0);
  }
});

test('安装期间丢租约不得发送，写入回执丢失不重发', async () => {
  const { fill, executor, params, calls } = setup();
  const install = executor.api.scripting.executeScript;
  executor.api.scripting.executeScript = async (spec) => {
    const result = await install(spec);
    executor.leases.delete(17);
    return result;
  };
  await assert.rejects(fill.execute(params));
  assert.equal(calls.filter((row) => row.message).length, 0);
  const next = setup();
  next.executor.api.tabs.sendMessage = async () => {
    throw Error('private error body');
  };
  await assert.rejects(
    next.fill.execute({ ...next.params, command: { operation: 'commit', grantHandle: 'grant' } }),
    (error) => error.message === 'PRODUCT_OUTCOME_UNKNOWN' && error.outcomeUnknown === true,
  );
});

test('安装期间同URL文档换代不得采纳新代次继续派发', async () => {
  const { fill, executor, params, calls } = setup();
  const install = executor.api.scripting.executeScript;
  executor.api.scripting.executeScript = async (spec) => {
    const result = await install(spec);
    executor.docs.set(17, 1);
    return result;
  };
  await assert.rejects(fill.execute(params), /PRODUCT_DOCUMENT_CHANGED/);
  assert.equal(calls.filter((row) => row.message).length, 0);
});

test('排队命令冻结参数，调用方后续修改不能替换真正派发的意图', async () => {
  const { fill, executor, params, calls } = setup();
  let release;
  executor.taskBarrier = async (_id, _write, fn) => {
    await new Promise((resolve) => {
      release = resolve;
    });
    return fn();
  };
  const work = fill.execute(params);
  params.command.operation = 'commit';
  params.command.grantHandle = 'injected';
  release();
  await work;
  assert.equal(calls.find((row) => row.message).message.command.operation, 'observe');
});

test('commit回执丢失后不能换requestId或新bind洗掉未知写入锁', async () => {
  const { fill, executor, task, params } = setup();
  const send = executor.api.tabs.sendMessage;
  let commits = 0;
  executor.api.tabs.sendMessage = async (...args) => {
    if (args[1].command.operation === 'commit') {
      commits++;
      throw Error('lost receipt');
    }
    return send(...args);
  };
  const commit = { ...params, command: { operation: 'commit', grantHandle: 'grant' } };
  await assert.rejects(fill.execute(commit), /PRODUCT_OUTCOME_UNKNOWN/);
  await assert.rejects(fill.execute({ ...commit, requestId: 'new-id' }));
  await fill.revoke(task, 'paused');
  await assert.rejects(fill.execute({ ...params, command: { operation: 'bind' } }));
  assert.equal(commits, 1);
});

test('安装回执期间暂停也保留页面通道供撤销，屏障不能伪报未安装', async () => {
  const { fill, executor, task, params, calls } = setup();
  const install = executor.api.scripting.executeScript;
  executor.api.scripting.executeScript = async (spec) => {
    const result = await install(spec);
    task.pauseRequested = true;
    return result;
  };
  await assert.rejects(fill.execute(params), /TASK_PAUSED/);
  await fill.revoke(task, 'paused');
  assert.equal(calls.filter((call) => call.message?.command.operation === 'revoke').length, 1);
});

test('未知写入暂停确认后status仅核实原编号，不恢复后续写入资格', async () => {
  const { fill, executor, task, params } = setup();
  const send = executor.api.tabs.sendMessage;
  executor.api.tabs.sendMessage = async (...args) =>
    args[1].command.operation === 'commit' ? { status: 'unknown' } : send(...args);
  const commit = { ...params, command: { operation: 'commit', grantHandle: 'grant' } };
  assert.equal((await fill.execute(commit)).status, 'unknown');
  await fill.revoke(task, 'paused');
  const receipt = await fill.execute({
    ...params,
    command: { operation: 'status', requestId: params.requestId },
  });
  assert.equal(receipt.operation, 'status');
  await assert.rejects(
    fill.execute({ ...commit, requestId: 'new-request' }),
    /PRODUCT_OUTCOME_UNKNOWN/,
  );
});

test('暂停后恢复不复活旧许可，显式新bind才解除本地fence', async () => {
  const { fill, task, params } = setup();
  await fill.execute(params);
  await fill.revoke(task, 'paused');
  await assert.rejects(fill.execute(params), /PRODUCT_AUTHORITY_REVOKED/);
  const bound = await fill.execute({
    ...params,
    command: { operation: 'bind', binding: { product: 'new' }, epoch: 2, submissionLocked: false },
  });
  assert.equal(bound.bound, true);
  assert.equal((await fill.execute(params)).operation, 'observe');
});

test('暂停屏障确认后可核旧绑定撤销，但只有新bind解除填写fence', async () => {
  const { fill, task, params } = setup();
  await fill.execute(params);
  await fill.revoke(task, 'paused');
  assert.equal(
    (await fill.execute({ ...params, command: { operation: 'revoke', reason: 'explicit_fill' } }))
      .revoked,
    true,
  );
  await assert.rejects(fill.execute(params), /PRODUCT_AUTHORITY_REVOKED/);
  await fill.execute({
    ...params,
    command: { operation: 'bind', binding: { product: 'new' }, epoch: 2, submissionLocked: false },
  });
  assert.equal((await fill.execute(params)).operation, 'observe');
});

test('撤销先fence排队命令，屏障后只向原文档撤销且不重装', async () => {
  const { fill, executor, task, params, calls } = setup();
  await fill.execute(params);
  let release;
  executor.taskBarrier = async (_id, _write, fn) => {
    await new Promise((resolve) => {
      release = resolve;
    });
    return fn();
  };
  const revoked = fill.revoke(task, 'paused');
  await assert.rejects(fill.execute(params), /PRODUCT_AUTHORITY_REVOKED/);
  release();
  await revoked;
  const last = calls.at(-1);
  assert.equal(last.message.command.operation, 'revoke');
  assert.equal(last.message.command.reason, 'paused');
  assert.deepEqual(last.target, { documentId: 'document-1' });
});
