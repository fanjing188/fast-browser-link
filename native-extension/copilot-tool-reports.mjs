import { TableJobs } from './copilot-table-job.mjs';
import { collectBrowserData } from './copilot-browser-data.mjs';
// 中文注释：只读状态标记；不读取账号文本、输入值或隐藏字段。
export function inspectToolPage(policy = {}, doc = globalThis.document) {
  const visible = (node) => {
    for (let el = node; el; el = el.parentElement) {
      const css = doc.defaultView.getComputedStyle(el);
      if (
        el.hidden ||
        el.getAttribute('aria-hidden') === 'true' ||
        css.display === 'none' ||
        css.visibility === 'hidden' ||
        css.opacity === '0'
      )
        return false;
    }
    return true;
  };
  const content = (node) => {
    const walker = doc.createTreeWalker(node, 4);
    let value = '',
      item;
    while ((item = walker.nextNode()))
      if (
        item.parentElement &&
        visible(item.parentElement) &&
        !item.parentElement.closest(
          'input,textarea,select,[contenteditable]:not([contenteditable="false"])',
        )
      )
        value += ' ' + item.textContent;
    return value;
  };
  const text = [...doc.querySelectorAll('h1,h2,h3,[role=alert],iframe[title]')]
    .filter(visible)
    .map((node) => (node.localName === 'iframe' ? node.title : content(node)))
    .join(' ')
    .slice(0, 10000);
  for (const [kind, patterns] of Object.entries(policy.stop_text || {}))
    if (patterns.some((pattern) => new RegExp(pattern, 'i').test(text)))
      return { ready: false, blocked: kind };
  if ([...doc.querySelectorAll('input[type=password]')].some(visible))
    return { ready: false, blocked: 'login' };
  if (/captcha|verify you are human|unusual traffic|验证码|人机验证/i.test(text))
    return { ready: false, blocked: 'captcha' };
  if (/quota exceeded|daily limit|额度用尽|配额耗尽/i.test(text))
    return { ready: false, blocked: 'quota' };
  if (/rate limit|too many requests|限流|请求过于频繁/i.test(text))
    return { ready: false, blocked: 'rate_limit' };
  if (/sign in to continue|session expired|登录过期|请先登录/i.test(text))
    return { ready: false, blocked: 'login' };
  const ready = (policy.ready_selectors || []).some((selector) =>
    [...doc.querySelectorAll(selector)].some(visible),
  );
  return { ready, blocked: null };
}
export async function collectToolReport(adapter, event, permitted, progress = async () => {}) {
  const { binding, tool, page, input, url } = event.params;
  if (event.kind === 'capability_probe') {
    let work, result, failure;
    try {
      if (!(await permitted())) throw Error('stopped');
      work = await adapter.open(url, { incognito: !!event.incognito, resourceId: event.id });
      result = await adapter.readData(work, inspectToolPage, [
        { ...(tool.probe || {}), stop_text: binding.stop_text },
      ]);
    } catch (error) {
      failure = error;
    } finally {
      if (work)
        try {
          await adapter.close(work);
        } catch {
          result = { ready: false, blocked: 'cleanup_unverified' };
          failure = null;
        }
    }
    if (failure)
      return {
        ready: false,
        blocked: ['work_origin_changed', 'work_ownership_changed', 'work_page_focused'].includes(
          failure.code,
        )
          ? failure.code
          : 'probe_unavailable',
      };
    return result;
  }
  if (binding.mode === 'search') {
    const value = await collectBrowserData(
      adapter,
      { ...event, kind: 'serp_top10', params: input },
      permitted,
    );
    return {
      records: (
        value.queries || [
          { keyword: input.keyword || input.keywords?.[0], results: value.results || [] },
        ]
      ).flatMap((query) =>
        query.results.slice(0, input.n || 10).map((row, index) => ({
          ...row,
          keyword: query.keyword,
          domain: new URL(row.url).hostname,
          rank: index + 1,
        })),
      ),
      source: value.source,
      missing: value.results?.length || value.queries?.length ? [] : ['search results unavailable'],
    };
  }
  if (binding.mode === 'trends_rising')
    return collectBrowserData(
      adapter,
      { ...event, kind: 'google_trends_rising', params: input },
      permitted,
    );
  if (binding.mode === 'trends') {
    const value = await collectBrowserData(
      adapter,
      { ...event, kind: 'google_trends', params: input },
      permitted,
    );
    return {
      ...value,
      missing:
        value.series.length < (input.keywords?.length || 1) * 4
          ? ['some trend contexts unavailable']
          : [],
    };
  }
  let work,
    closed = false,
    captured,
    result,
    cleanupIssue = false;
  const finish = (value) => {
    result = value;
    return value;
  };
  const close = async (workspace) => {
    if (!closed) {
      closed = true;
      try {
        await adapter.close(workspace);
      } catch {
        cleanupIssue = true;
      }
    }
  };
  const check = async () => {
    if (!(await permitted())) throw Error('stopped');
    const status = await adapter.readData(work, inspectToolPage, [
      { ready_selectors: [binding.query_submit?.root || 'body'], stop_text: binding.stop_text },
    ]);
    return status;
  };
  try {
    if (!(await permitted())) throw Error('stopped');
    work = await adapter.open(url, { incognito: !!event.incognito, resourceId: event.id });
    const status = await check();
    if (status.blocked) return finish({ records: [], source: binding.id, blocked: status.blocked });
    if (binding.query_submit) {
      if (!status.ready) throw Error('report query not ready');
      await adapter.submitQuery(work, binding.query_submit);
    }
    const snapshot = await adapter.read(work, {
      minimumRows: 1,
      headers: Object.values(page.columns || {}).flat(),
      selectors: page.table_selectors || [],
    });
    if (snapshot.blocked)
      return finish({
        records: [],
        source: binding.id,
        blocked: /登录/.test(snapshot.blocked)
          ? 'login'
          : /验证码/.test(snapshot.blocked)
            ? 'captcha'
            : /额度/.test(snapshot.blocked)
              ? 'quota'
              : 'page_blocked',
      });
    const aliases = new Set(
      Object.values(page.columns || {})
        .flat()
        .map((value) => value.toLowerCase().trim()),
    );
    const candidates = snapshot.tables.filter((table) =>
      table.headers.some((header) => aliases.has(header.toLowerCase().trim())),
    );
    if (candidates.length !== 1)
      return finish({
        records: [],
        source: binding.id,
        missing: ['report table missing or ambiguous'],
      });
    const blocked = { kind: null };
    const guarded = {
      ...adapter,
      open: async (initial) => {
        if (initial !== url) await adapter.navigate(work, initial);
        return work;
      },
      read: async (workspace) => {
        const status = await check();
        if (status.blocked) {
          blocked.kind = status.blocked;
          throw Error('后台来源已停用');
        }
        return adapter.read(workspace, {
          minimumRows: 1,
          headers: Object.values(page.columns || {}).flat(),
          selectors: page.table_selectors || [],
        });
      },
      advance: async (...args) => {
        if (!(await permitted())) throw Error('stopped');
        return adapter.advance(...args);
      },
      navigate: async (...args) => {
        if (!(await permitted())) throw Error('stopped');
        return adapter.navigate(...args);
      },
      close,
    };
    const jobs = new TableJobs({
      ...guarded,
      requireFiles: false,
      upload: async (table) => {
        captured = table;
        return { rows: table.rows.length };
      },
      progress: (job) => {
        void progress({ id: event.id, text: `page ${job.pages || 1} · ${job.rowCount || 0} rows` });
      },
    });
    try {
      await jobs.run(event.id, snapshot, candidates[0], {
        max_pages: binding.max_pages || 50,
        delay_min: binding.delay_min ?? 1.5,
        delay_max: binding.delay_max ?? 3,
      });
    } catch {
      captured = {
        ...candidates[0],
        partial: true,
        reason: 'page budget requires confirmation or collection failed',
      };
    }
    return finish({
      table: captured,
      source: binding.id,
      blocked:
        blocked.kind ||
        (/清理/.test(captured.reason || '')
          ? 'cleanup_unverified'
          : /归属|来源|后台来源/.test(captured.reason || '')
            ? 'scope_or_page_unavailable'
            : null),
      partial: !!captured.partial,
      missing: captured.reason ? [captured.reason] : [],
      pages: captured.pages || 1,
    });
  } catch (error) {
    return finish({
      records: [],
      source: binding.id,
      blocked:
        error.code === 'query_control_unavailable' ? error.code : 'scope_or_page_unavailable',
      missing: [
        error.code === 'query_control_unavailable'
          ? 'query button missing or ambiguous'
          : 'background page inaccessible',
      ],
    });
  } finally {
    if (work) await close(work);
    if (cleanupIssue && result) {
      result.blocked = 'cleanup_unverified';
      result.partial = true;
      result.missing = [...(result.missing || []), 'work-page cleanup unverified'];
    }
  }
}
