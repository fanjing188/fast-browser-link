import test from 'node:test';
import assert from 'node:assert/strict';
import { AssistController } from '../../native-extension/assist-controller.mjs';

test('table reader signs opaque table handles and advance resolves only this session/work', async () => {
  const calls = [];
  const bridge = {
    request: async (method, params) => {
      calls.push({ method, params });
      return {
        ok: true,
        value: {
          url: 'https://fixture.test/',
          tables: [{ id: 'table', dom_path: 'table', headers: ['Name'], rows: [] }],
        },
      };
    },
  };
  const controller = new AssistController({}, () => bridge, {});
  const session = Object.freeze({ productId: 'a'.repeat(32), session: 'port' });
  const snapshot = await controller.dispatch(session, 'work.tables_read', { workHandle: 'w' });
  assert.ok(snapshot.tables[0].tableHandle);
  await controller.dispatch(session, 'work.table_advance', {
    workHandle: 'w',
    tableHandle: snapshot.tables[0].tableHandle,
    kind: 'button',
    requestId: 'once',
  });
  assert.deepEqual(calls.at(-1).params.arguments, { headers: ['Name'], kind: 'button' });
  await assert.rejects(
    controller.dispatch({ ...session, session: 'other' }, 'work.table_advance', {
      workHandle: 'w',
      tableHandle: snapshot.tables[0].tableHandle,
      kind: 'button',
      requestId: 'forged',
    }),
  );
});
