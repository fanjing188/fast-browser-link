// 中文注释：离线测量扩展运行时和模拟 CDP 往返；不连接浏览器、不接收页面数据。
import { performance } from 'node:perf_hooks';
import { PageRuntime } from '../../native-extension/page-runtime.mjs';

const samples = new Map();
const record = (name, elapsed) => samples.set(name, [...(samples.get(name) || []), elapsed]);
const task = { id: 'timing', policy: { activeMode: 'full' }, revoked: false };
const executor = {
  leases: new Map([[1, 'timing']]),
  api: {
    debugger: {
      sendCommand: async (_target, method) => {
        const start = performance.now();
        let result = {};
        if (method === 'Page.createIsolatedWorld') result = { executionContextId: 1 };
        if (method === 'Runtime.evaluate')
          result = { result: { type: 'function', objectId: 'fn' } };
        if (method === 'Runtime.callFunctionOn') result = { result: { type: 'number', value: 1 } };
        record(method, performance.now() - start);
        return result;
      },
    },
  },
  checkedFrameTree: async () => ({ frame: { id: 'frame', loaderId: 'doc' } }),
};
const runtime = new PageRuntime(executor);
for (let i = 0; i < 100; i++) {
  const start = performance.now();
  await runtime.evaluate(task, { tabId: 1, expression: '()=>1' }, () => {});
  record('extension_total', performance.now() - start);
}
for (const [name, values] of samples) {
  values.sort((a, b) => a - b);
  process.stdout.write(
    `${name} count=${values.length} median_ms=${values[Math.floor(values.length / 2)].toFixed(4)}\n`,
  );
}
