import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { AgentPanel } from '../../native-extension/copilot-agent-panel.mjs';
import { mountControls } from '../../native-extension/copilot-controls.mjs';
const html = await readFile(
  new URL('../../native-extension/copilot-panel.html', import.meta.url),
  'utf8',
);
const flush = async () => {
  for (let i = 0; i < 3; i++) await new Promise((done) => setImmediate(done));
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const agent = (extra = {}) => ({
  id: 'hermes',
  name: 'Hermes',
  installed: false,
  configured: false,
  status: 'not_installed',
  can_setup: true,
  setup_action: 'install_engine',
  ...extra,
});
const catalog = (extra = {}) => ({
  default_agent: 'hermes',
  onboarding_required: true,
  agents: [agent()],
  ...extra,
});
const connection = {
  inference: 'connected',
  execution: 'connected',
  check: 'acp_initialize',
  model_call: false,
};
function fixture(handler, { onEnable = async () => true } = {}) {
  const dom = new JSDOM(html, { pretendToBeVisual: true }),
    doc = dom.window.document,
    calls = [],
    changes = [],
    timers = new Map();
  let next = 0;
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
    this.dispatchEvent(new dom.window.Event('close'));
  };
  dom.window.setTimeout = (work) => {
    timers.set(++next, work);
    return next;
  };
  dom.window.clearTimeout = (id) => timers.delete(id);
  const panel = new AgentPanel(
      doc,
      async (name, params) => {
        calls.push([name, params]);
        return handler(name, params);
      },
      { language: 'en', onChange: (value) => changes.push(value), onEnable },
    ),
    controls = mountControls(doc);
  return {
    dom,
    doc,
    calls,
    changes,
    panel,
    timers,
    dialog: doc.getElementById('agent-setup-dialog'),
    async poll() {
      assert.equal(timers.size, 1);
      const [id, work] = timers.entries().next().value;
      timers.delete(id);
      work();
      await flush();
    },
    snapshot() {
      return {
        html: doc.documentElement.outerHTML,
        values: [...doc.querySelectorAll('select')].map((select) => [select.id, select.value]),
      };
    },
    close() {
      panel.dispose();
      controls.dispose();
      dom.window.close();
    },
  };
}
test('first detection opens onboarding with an install action but performs no setup or default writes', async () => {
  const f = fixture(async (name) => {
    assert.equal(name, 'agent_catalog');
    return catalog();
  });
  try {
    await f.panel.refresh();
    await flush();
    assert.equal(f.dialog.open, true);
    assert.deepEqual(f.calls, [['agent_catalog', {}]]);
    assert.match(f.doc.getElementById('agent-setup-start').textContent, /Install Hermes/);
    assert.equal(f.doc.getElementById('agent-enable').hidden, true);
    assert.equal(f.doc.querySelector('[data-step=detect]').dataset.state, 'done');
    assert.equal(f.doc.querySelector('[data-step=ready]').dataset.state, 'idle');
    assert.equal(
      f.doc.getElementById('agent-setup-select').hidden,
      true,
      'shared controls own the select UI',
    );
    assert.equal(f.changes.length, 1);
  } finally {
    f.close();
  }
});
test('configured catalog remains out of the first screen and does not claim live collaboration', async () => {
  const f = fixture(async () =>
    catalog({
      onboarding_required: false,
      agents: [
        agent({
          installed: true,
          configured: true,
          status: 'configured',
          setup_action: 'configure',
        }),
      ],
    }),
  );
  try {
    await f.panel.refresh();
    assert.equal(f.dialog.open, false);
    assert.match(f.doc.getElementById('agent-default-status').textContent, /Configured/);
    assert.doesNotMatch(
      f.doc.getElementById('agent-default-status').textContent,
      /Connected|Running/,
    );
    assert.equal(await f.panel.ensureReady(), true);
    assert.deepEqual(
      f.calls.map(([name]) => name),
      ['agent_catalog', 'agent_catalog'],
    );
  } finally {
    f.close();
  }
});
test('real detection errors open a retryable dialog and never reuse stale configured readiness', async () => {
  let failed = false;
  const f = fixture(async () => {
    if (failed) throw Error('native_host_missing');
    return catalog({
      onboarding_required: false,
      agents: [agent({ installed: true, configured: true, status: 'configured' })],
    });
  });
  try {
    await f.panel.refresh();
    failed = true;
    assert.equal(await f.panel.ensureReady(), false);
    assert.equal(f.dialog.open, true);
    assert.match(f.doc.getElementById('agent-setup-notice').textContent, /native_host_missing/);
    assert.equal(f.doc.getElementById('agent-enable').hidden, true);
    failed = false;
    await f.doc.getElementById('agent-refresh').onclick();
    assert.equal(f.panel.ready(), true);
    assert.equal(
      f.calls.some(([name]) => name !== 'agent_catalog'),
      false,
    );
  } finally {
    f.close();
  }
});
test('setup progresses only from host receipts and completed checks do not enable collaboration automatically', async () => {
  const completed = {
    id: 'setup-1',
    agent_id: 'hermes',
    status: 'completed',
    phase: 'complete',
    connection,
  };
  let phase = 0,
    done = false,
    enabled = 0;
  const f = fixture(
    async (name, params) => {
      if (name === 'agent_catalog')
        return catalog(
          done
            ? {
                onboarding_required: false,
                agents: [
                  agent({
                    installed: true,
                    configured: true,
                    status: 'configured',
                    setup_action: 'configure',
                  }),
                ],
                job: completed,
              }
            : {},
        );
      if (name === 'agent_setup_start') {
        assert.deepEqual(params, { agent_id: 'hermes' });
        return { id: 'setup-1', agent_id: 'hermes', status: 'pending', phase: 'detect' };
      }
      if (name === 'agent_setup_status') {
        assert.deepEqual(params, { id: 'setup-1' });
        phase++;
        if (phase === 1)
          return { id: 'setup-1', agent_id: 'hermes', status: 'pending', phase: 'integration' };
        if (phase === 2)
          return { id: 'setup-1', agent_id: 'hermes', status: 'pending', phase: 'connection' };
        done = true;
        return completed;
      }
      throw Error(name);
    },
    {
      onEnable: async () => {
        enabled++;
        return true;
      },
    },
  );
  try {
    await f.panel.refresh();
    const work = f.doc.getElementById('agent-setup-start').onclick();
    await flush();
    assert.equal(f.doc.querySelector('[data-step=ready]').dataset.state, 'idle');
    assert.equal(enabled, 0);
    await f.poll();
    assert.equal(f.doc.querySelector('[data-step=configure]').dataset.state, 'active');
    await f.poll();
    assert.equal(f.doc.querySelector('[data-step=check]').dataset.state, 'active');
    await f.poll();
    await work;
    assert.equal(f.doc.querySelector('[data-step=ready]').dataset.state, 'done');
    assert.equal(f.doc.getElementById('agent-enable').hidden, false);
    assert.equal(enabled, 0);
    assert.equal(f.dialog.open, true);
    await f.doc.getElementById('agent-enable').onclick();
    assert.equal(enabled, 1);
    assert.equal(f.dialog.open, false);
  } finally {
    f.close();
  }
});
test('authentication failure preserves its failed phase and asks for local model configuration without collecting credentials', async () => {
  const job = {
      id: 'setup-auth',
      agent_id: 'hermes',
      status: 'failed',
      phase: 'connection',
      error: 'auth_required',
      next_command: 'hermes model',
    },
    f = fixture(async (name) => (name === 'agent_catalog' ? catalog() : job));
  try {
    await f.panel.refresh();
    await f.panel.start();
    assert.equal(f.dialog.open, true);
    assert.equal(f.panel.job.status, 'failed');
    assert.match(f.doc.getElementById('agent-setup-notice').textContent, /hermes model/);
    assert.equal(f.doc.getElementById('agent-enable').hidden, true);
    assert.equal(f.doc.querySelector('[data-step=check]').dataset.state, 'error');
    assert.equal(f.dialog.querySelector('input[type=password]'), null);
    assert.equal(f.doc.getElementById('agent-setup-start').disabled, false);
  } finally {
    f.close();
  }
});
test('incomplete completed receipts never expose start collaboration as ready', async () => {
  const f = fixture(async (name) =>
    name === 'agent_catalog'
      ? catalog()
      : { id: 'incomplete', agent_id: 'hermes', status: 'completed', phase: 'complete' },
  );
  try {
    await f.panel.refresh();
    await f.panel.start();
    assert.equal(f.doc.getElementById('agent-enable').hidden, true);
    assert.match(
      f.doc.getElementById('agent-setup-notice').textContent,
      /no verified connection check/,
    );
    assert.equal(f.panel.ready(), false);
  } finally {
    f.close();
  }
});
test('poll failure preserves the job for an explicit status retry without starting installation again', async () => {
  let fail = true;
  const f = fixture(async (name) => {
    if (name === 'agent_catalog') return catalog();
    if (name === 'agent_setup_start')
      return { id: 'pending-job', agent_id: 'hermes', status: 'pending', phase: 'profiles' };
    if (name === 'agent_setup_status') {
      if (fail) throw Error('connection lost');
      return {
        id: 'pending-job',
        agent_id: 'hermes',
        status: 'failed',
        phase: 'connection',
        error: 'connection_failed',
      };
    }
    throw Error(name);
  });
  try {
    await f.panel.refresh();
    const start = f.panel.start();
    await flush();
    await f.poll();
    await start;
    assert.equal(f.panel.job.id, 'pending-job');
    assert.equal(f.doc.getElementById('agent-refresh').disabled, false);
    assert.equal(f.doc.getElementById('agent-setup-start').disabled, true);
    fail = false;
    const retry = f.doc.getElementById('agent-refresh').onclick();
    await flush();
    await f.poll();
    await retry;
    assert.equal(f.calls.filter(([name]) => name === 'agent_setup_start').length, 1);
    assert.equal(f.calls.filter(([name]) => name === 'agent_setup_status').length, 2);
  } finally {
    f.close();
  }
});
test('default agent values come from the registry and change only on explicit selection', async () => {
  let defaultId = 'local-b';
  const agents = [
      agent({ installed: true, configured: true, status: 'configured' }),
      agent({
        id: 'local-b',
        name: 'Registry agent',
        installed: true,
        configured: true,
        status: 'configured',
      }),
    ],
    f = fixture(async (name, params) => {
      if (name === 'agent_select') defaultId = params.agent_id;
      return catalog({ default_agent: defaultId, onboarding_required: false, agents });
    });
  try {
    await f.panel.refresh();
    assert.equal(f.doc.getElementById('agent-default-select').value, 'local-b');
    assert.deepEqual(f.calls, [['agent_catalog', {}]]);
    const select = f.doc.getElementById('agent-default-select');
    select.value = 'hermes';
    await select.onchange({ target: select });
    assert.deepEqual(f.calls.at(-1), ['agent_select', { agent_id: 'hermes' }]);
    assert.equal(select.value, 'hermes');
    assert.equal(f.panel.catalog.default_agent, 'hermes');
  } finally {
    f.close();
  }
});
test('later closes onboarding with focus restored and no installation write', async () => {
  const f = fixture(async () => catalog());
  try {
    const trigger = f.doc.getElementById('agent-settings-open');
    trigger.focus();
    await f.panel.refresh();
    assert.equal(f.dialog.open, true);
    f.doc.getElementById('agent-later').click();
    assert.equal(f.dialog.open, false);
    assert.equal(f.doc.activeElement, trigger);
    assert.deepEqual(f.calls, [['agent_catalog', {}]]);
  } finally {
    f.close();
  }
});
test('dispose cancels a late pending setup start without changing DOM or polling', async () => {
  const start = deferred(),
    f = fixture(async (name) => {
      if (name === 'agent_catalog') return catalog();
      if (name === 'agent_setup_start') return start.promise;
      if (name === 'agent_setup_cancel') return { status: 'cancelled' };
      throw Error(name);
    });
  try {
    await f.panel.refresh();
    const work = f.panel.start();
    await flush();
    f.panel.dispose();
    const before = f.snapshot();
    start.resolve({ id: 'late-job', agent_id: 'hermes', status: 'pending', phase: 'detect' });
    await work;
    await flush();
    assert.deepEqual(f.snapshot(), before);
    assert.deepEqual(
      f.calls.filter(([name]) => name !== 'agent_catalog'),
      [
        ['agent_setup_start', { agent_id: 'hermes' }],
        ['agent_setup_cancel', { id: 'late-job' }],
      ],
    );
    assert.equal(f.timers.size, 0);
  } finally {
    start.resolve({});
    f.close();
  }
});
test('dispose cancels an outstanding poll once and ignores its late completion', async () => {
  const status = deferred(),
    f = fixture(async (name) => {
      if (name === 'agent_catalog') return catalog();
      if (name === 'agent_setup_start')
        return { id: 'polled-job', agent_id: 'hermes', status: 'pending', phase: 'connection' };
      if (name === 'agent_setup_status') return status.promise;
      if (name === 'agent_setup_cancel') return { status: 'cancelled' };
      throw Error(name);
    });
  try {
    await f.panel.refresh();
    const work = f.panel.start();
    await flush();
    await f.poll();
    f.panel.dispose();
    const before = f.snapshot();
    status.resolve({
      id: 'polled-job',
      agent_id: 'hermes',
      status: 'completed',
      phase: 'complete',
      connection,
    });
    await work;
    await flush();
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.calls.filter(([name]) => name === 'agent_setup_cancel').length, 1);
    assert.equal(f.calls.filter(([name]) => name === 'agent_catalog').length, 1);
    assert.equal(f.timers.size, 0);
  } finally {
    status.resolve({});
    f.close();
  }
});
test('late catalog receipts after disposal do not render or open onboarding', async () => {
  const response = deferred(),
    f = fixture(async () => response.promise);
  try {
    const work = f.panel.refresh();
    f.panel.dispose();
    const before = f.snapshot();
    response.resolve(catalog());
    await work;
    await flush();
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.dialog.open, false);
    assert.equal(f.changes.length, 0);
  } finally {
    response.resolve({});
    f.close();
  }
});
test('catalog reload retains failed setup instructions and selection failures remain visible in settings', async () => {
  const job = {
      id: 'previous',
      agent_id: 'hermes',
      status: 'failed',
      phase: 'connection',
      error: 'auth_required',
      next_command: 'hermes model',
    },
    f = fixture(async (name) => {
      if (name === 'agent_select') throw Error('agent_busy');
      return catalog({ job });
    });
  try {
    await f.panel.refresh();
    assert.match(f.doc.getElementById('agent-setup-notice').textContent, /hermes model/);
    await f.panel.select('hermes');
    assert.match(f.doc.getElementById('agent-default-status').textContent, /agent_busy/);
    assert.equal(f.doc.getElementById('agent-default-status').dataset.state, 'error');
    assert.equal(f.doc.getElementById('agent-default-select').value, 'hermes');
  } finally {
    f.close();
  }
});
test('a runtime enable failure leaves configured onboarding open with an actionable message', async () => {
  const f = fixture(
    async () =>
      catalog({
        onboarding_required: false,
        agents: [agent({ installed: true, configured: true, status: 'configured' })],
      }),
    { onEnable: async () => false },
  );
  try {
    await f.panel.open();
    await f.panel.enable();
    assert.equal(f.dialog.open, true);
    assert.match(f.doc.getElementById('agent-setup-notice').textContent, /has not started/);
    assert.equal(f.doc.getElementById('agent-enable').disabled, false);
  } finally {
    f.close();
  }
});
test('setup double-clicks cannot start a second installation and polling only starts after the host response', async () => {
  const start = deferred(),
    f = fixture(async (name) => {
      if (name === 'agent_catalog') return catalog();
      if (name === 'agent_setup_start') return start.promise;
      throw Error(name);
    });
  try {
    await f.panel.refresh();
    const first = f.panel.start();
    await f.panel.start();
    assert.equal(f.calls.filter(([name]) => name === 'agent_setup_start').length, 1);
    assert.equal(f.timers.size, 0);
    start.resolve({
      id: 'failed',
      agent_id: 'hermes',
      status: 'failed',
      phase: 'install_engine',
      error: 'engine_install_failed',
    });
    await first;
    assert.equal(f.timers.size, 0);
    assert.match(f.doc.getElementById('agent-setup-notice').textContent, /installation failed/);
  } finally {
    start.resolve({});
    f.close();
  }
});
test('a completed job followed by an unavailable catalog does not announce readiness', async () => {
  let reads = 0;
  const f = fixture(async (name) => {
    if (name === 'agent_catalog') {
      if (++reads > 1) throw Error('host_disconnected');
      return catalog();
    }
    return { id: 'done', agent_id: 'hermes', status: 'completed', phase: 'complete', connection };
  });
  try {
    await f.panel.refresh();
    await f.panel.start();
    assert.equal(f.doc.getElementById('agent-enable').hidden, true);
    assert.match(f.doc.getElementById('agent-setup-notice').textContent, /host_disconnected/);
    assert.doesNotMatch(f.doc.getElementById('agent-setup-notice').textContent, /checks passed/);
  } finally {
    f.close();
  }
});
test('manual installation repair explains preserved configuration and links only to fixed official guidance', async () => {
  const job = {
      id: 'manual',
      agent_id: 'hermes',
      status: 'failed',
      phase: 'install_engine',
      error: 'engine_existing_configuration_requires_manual',
      installation: { url: 'https://untrusted.example.test/install', command: 'UNTRUSTED_COMMAND' },
    },
    f = fixture(async () => catalog({ job }));
  try {
    await f.panel.refresh();
    const notice = f.doc.getElementById('agent-setup-notice');
    assert.match(notice.textContent, /preserve your existing configuration/);
    const help = f.doc.getElementById('agent-installation-help'),
      link = help.querySelector('a');
    assert.equal(help.hidden, false);
    assert.equal(
      link.href,
      'https://hermes-agent.nousresearch.com/docs/getting-started/installation',
    );
    assert.equal(link.target, '_blank');
    assert.ok(link.rel.includes('noopener'));
    assert.doesNotMatch(f.dialog.textContent, /UNTRUSTED_COMMAND|untrusted.example.test/);
    assert.equal(f.doc.getElementById('agent-enable').hidden, true);
  } finally {
    f.close();
  }
});
test('an independently configured registry candidate can explicitly become default despite unfinished default onboarding', async () => {
  const candidate = agent({
    id: 'local-b',
    name: 'Registry agent',
    installed: true,
    configured: true,
    status: 'configured',
  });
  let enabled = 0;
  const f = fixture(
    async (name, params) => {
      if (name === 'agent_select') {
        assert.deepEqual(params, { agent_id: 'local-b' });
        return catalog({
          default_agent: 'local-b',
          onboarding_required: false,
          agents: [agent(), candidate],
        });
      }
      return catalog({ agents: [agent(), candidate] });
    },
    {
      onEnable: async () => {
        enabled++;
        return true;
      },
    },
  );
  try {
    await f.panel.refresh();
    assert.equal(f.panel.ready(), false);
    const select = f.doc.getElementById('agent-setup-select');
    select.value = 'local-b';
    select.onchange({ target: select });
    assert.equal(f.panel.ready('local-b'), true);
    assert.equal(f.doc.getElementById('agent-enable').hidden, false);
    assert.match(f.doc.getElementById('agent-enable').textContent, /Set default/);
    assert.equal(
      f.calls.some(([name]) => name === 'agent_select'),
      false,
    );
    await f.panel.enable();
    assert.equal(f.panel.catalog.default_agent, 'local-b');
    assert.equal(enabled, 1);
    assert.equal(f.dialog.open, false);
  } finally {
    f.close();
  }
});
test('pending setup labels later as background continuation and closing does not cancel the active job', async () => {
  const f = fixture(async (name) =>
    name === 'agent_catalog'
      ? catalog()
      : { id: 'background', agent_id: 'hermes', status: 'pending', phase: 'profiles' },
  );
  try {
    await f.panel.refresh();
    const work = f.panel.start();
    await flush();
    assert.equal(f.doc.getElementById('agent-later').textContent, 'Continue in background');
    f.doc.getElementById('agent-later').click();
    assert.equal(f.dialog.open, false);
    assert.equal(
      f.calls.some(([name]) => name === 'agent_setup_cancel'),
      false,
    );
    f.panel.dispose();
    await work;
    assert.equal(f.calls.filter(([name]) => name === 'agent_setup_cancel').length, 1);
  } finally {
    f.close();
  }
});
test('active collaboration prevents agent reconfiguration while preserving the configured and ready facts', async () => {
  const f = fixture(async () =>
    catalog({
      busy: true,
      onboarding_required: false,
      agents: [
        agent({
          installed: true,
          configured: true,
          status: 'configured',
          can_setup: false,
          setup_action: 'configure',
        }),
      ],
    }),
  );
  try {
    await f.panel.refresh();
    await flush();
    for (const id of ['agent-default-select', 'agent-setup-select']) {
      const select = f.doc.getElementById(id);
      assert.equal(select.disabled, true);
      assert.equal(select.nextElementSibling.querySelector('[role=combobox]').disabled, true);
    }
    assert.equal(f.panel.ready(), true);
    assert.match(f.doc.getElementById('agent-default-status').textContent, /Configured/);
    assert.match(
      f.doc.getElementById('agent-default-status').textContent,
      /Turn off Assist and wait for tasks/,
    );
    await f.panel.select('hermes');
    await f.panel.start();
    assert.deepEqual(f.calls, [['agent_catalog', {}]]);
    assert.equal(f.doc.getElementById('agent-setup-start').disabled, true);
  } finally {
    f.close();
  }
});
test('a failed default switch asks to turn collaboration off rather than merely pause it', async () => {
  const f = fixture(async (name) => {
    if (name === 'agent_select') throw Error('agent_busy');
    return catalog();
  });
  try {
    await f.panel.refresh();
    await f.panel.select('hermes');
    assert.match(f.doc.getElementById('agent-default-status').textContent, /Turn off Assist/);
    assert.doesNotMatch(
      f.doc.getElementById('agent-default-status').textContent,
      /Pause collaboration/,
    );
  } finally {
    f.close();
  }
});

test('Codex guide displays manual commands and restricted inference without starting setup', async () => {
  const f = fixture(async (name) => {
    assert.equal(name, 'agent_catalog');
    return catalog({
      default_agent: 'codex',
      agents: [agent({ id: 'codex', name: 'Codex', setup_action: 'manual_install' })],
    });
  });
  try {
    await f.panel.refresh();
    assert.match(f.doc.getElementById('agent-detection').textContent, /restricted mode/);
    const help = f.doc.getElementById('agent-installation-help');
    assert.equal(help.hidden, false);
    assert.equal(help.querySelector('a').href, 'https://developers.openai.com/codex/cli');
    assert.match(
      help.querySelector('code').textContent,
      /npm install -g @openai\/codex.*codex login/,
    );
    assert.deepEqual(f.calls, [['agent_catalog', {}]]);
    assert.match(
      f.panel.jobError({ agent_id: 'codex', error: 'codex_unsupported_version' }),
      /version unsupported.*0\.162\.1/,
    );
    assert.match(
      f.panel.jobError({ agent_id: 'codex', error: 'codex_auth_missing' }),
      /codex login/,
    );
    assert.equal(
      f.panel.connectionChecked({ connection: { ...connection, check: 'codex_initialize' } }),
      true,
    );
  } finally {
    f.close();
  }
});
