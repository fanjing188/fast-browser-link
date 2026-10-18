import { captureTables, advanceTable, tableRowKey, tableIdentity } from './copilot-tables.mjs';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const READ_ATTEMPTS = 40;
const signature = (table) => JSON.stringify(table.headers);
export class TableJobs {
  constructor({
    open,
    read,
    advance,
    navigate,
    close,
    upload,
    progress,
    requireFiles = true,
    delay = sleep,
    random = Math.random,
  }) {
    Object.assign(this, {
      open,
      read,
      advance,
      navigate,
      close,
      upload,
      progress,
      requireFiles,
      delay,
      random,
    });
    this.jobs = new Map();
  }
  stop(id) {
    const job = this.jobs.get(id);
    if (job) job.stop = true;
  }
  async run(id, capture, table, settings = {}, confirmed = false, approvedLimit = 0) {
    if (this.jobs.has(id)) throw Error('表格正在收集');
    const limit = settings.max_pages || 50;
    if ((table.pagination.totalPages || 0) > limit && !confirmed)
      throw Error(`超过${limit}页，需要再次确认`);
    const max = confirmed
      ? Math.min(approvedLimit > 0 ? approvedLimit : table.pagination.totalPages || limit, 200)
      : limit;
    const job = {
      id,
      stop: false,
      rows: [],
      pages: 0,
      status: 'executing',
      reason: '',
      sourceKey: capture.url + '|' + table.id,
      sourceIdentity: tableIdentity(capture, table),
      deduplication: 'row_index',
      unit: table.pagination.kind === 'scroll' ? '批' : '页',
    };
    this.jobs.set(id, job);
    try {
      const seen = new Set(),
        pages = new Set();
      let workspace;
      const collect = (item, url) => {
        const occurrences = new Map();
        for (const [index, row] of item.rows.entries()) {
          const content = tableRowKey(row),
            identity = item.row_keys?.[index],
            count = occurrences.get(content) || 0;
          occurrences.set(content, count + 1);
          if (!identity) job.deduplication = 'content_occurrence';
          const key = identity
            ? 'row:' + identity + '|' + (table.pagination.kind === 'url' ? url : '') + '|' + content
            : 'content:' + content + '|' + count;
          if (!seen.has(key)) {
            seen.add(key);
            job.rows.push(row);
          }
        }
        pages.add(url);
        job.pages = pages.size;
      };
      collect(table, capture.url);
      this.progress({
        ...job,
        rows: undefined,
        rowCount: job.rows.length,
        totalPages: table.pagination.totalPages,
      });
      try {
        const initial = new URL(capture.url),
          pager = table.pagination;
        if (pager.kind === 'url')
          initial.searchParams.set(pager.key, /offset|start/i.test(pager.key) ? '0' : '1');
        workspace = await this.open(initial.href, { incognito: !!capture.incognito });
        let unchanged = 0,
          complete = false;
        for (let scan = 0; scan < max && !job.stop; scan++) {
          const snapshot = await this.read(workspace),
            candidates = snapshot.tables.filter((t) => signature(t) === signature(table));
          const identified = table.dom_id
            ? candidates.filter((t) => t.dom_id === table.dom_id)
            : candidates.filter((t) => t.name === table.name);
          const current =
            candidates.length === 1
              ? candidates[0]
              : identified.length === 1
                ? identified[0]
                : null;
          if (snapshot.blocked) throw Error(snapshot.blocked);
          if (!current) throw Error('表格结构变化或页面未就绪');
          if (new URL(snapshot.url).origin !== new URL(capture.url).origin)
            throw Error('页面跳转到登录或其他来源');
          const before = job.rows.length;
          collect(
            current,
            snapshot.url +
              ((pager.kind === 'scroll' || pager.kind === 'button') && scan
                ? '#batch=' + scan
                : ''),
          );
          unchanged = job.rows.length === before ? unchanged + 1 : 0;
          this.progress({
            ...job,
            rows: undefined,
            rowCount: job.rows.length,
            totalPages: pager.totalPages,
          });
          if (job.rows.length >= 50000) throw Error('达到50000行本机导出上限');
          if (unchanged >= 3) throw Error('后台页面没有新行，可能受节流或虚拟渲染影响');
          const currentPage = current.pagination.current;
          if (
            pager.totalPages &&
            pager.kind === 'url' &&
            !/offset|start/i.test(pager.key) &&
            currentPage >= pager.totalPages
          ) {
            complete = true;
            break;
          }
          if (pager.totalRows && job.rows.length >= pager.totalRows) {
            complete = true;
            break;
          }
          if (pager.kind === 'none') {
            complete = true;
            break;
          }
          if (pages.size >= max) {
            job.reason = '已达本次页数上限，保存已收部分；调整配置后重新收集';
            break;
          }
          const min = settings.delay_min ?? 1.5,
            maxDelay = settings.delay_max ?? 3;
          await this.delay((min + this.random() * Math.max(0, maxDelay - min)) * 1000);
          if (job.stop) break;
          if (pager.kind === 'url') {
            if (
              current.pagination.totalPages === null &&
              !current.pagination.next &&
              unchanged > 0
            ) {
              job.reason = '无法确认后续页或站点重复返回相同行';
              break;
            }
            const url = new URL(snapshot.url);
            url.searchParams.set(
              pager.key,
              String(Number(url.searchParams.get(pager.key)) + pager.offsetStep),
            );
            await this.navigate(workspace, url.href);
          } else {
            const step = await this.advance(workspace, {
              headers: table.headers,
              kind: pager.kind,
            });
            if (step.blocked) throw Error(step.blocked);
            if (step.done) {
              if (
                (pager.totalPages && job.pages < pager.totalPages) ||
                (pager.kind === 'scroll' && pager.totalRows && job.rows.length < pager.totalRows)
              )
                job.reason = '分页或滚动已结束，但未达到声明总量，可能不完整';
              else complete = true;
              break;
            }
          }
        }
        if (!complete && !job.reason && !job.stop) job.reason = '达到采集批次上限，保存已收部分';
        if (table.truncated && !job.reason)
          job.reason = '当前表格达到DOM取样保护上限，内容可能不完整';
        if (job.stop) job.reason = '已停止，保存已收部分';
      } catch (error) {
        const message = error.message || '';
        job.reason = /登录|验证码|额度|结构|工作页|后台|页数|上限|无法|分页|滚动/.test(message)
          ? message.slice(0, 250)
          : '后台页面操作受阻，保存已收部分';
      } finally {
        if (workspace)
          try {
            await this.close(workspace);
          } catch {
            job.reason += '；工作页清理待核实';
          }
      }
      const result = await this.upload(
        {
          name: table.name,
          site: new URL(capture.url).hostname,
          headers: table.headers,
          rows: job.rows,
          pages: job.pages,
          unit: job.unit,
          partial: !!(job.reason || table.truncated),
          reason: job.reason,
        },
        'both',
      );
      job.export = { ...result, deduplication: job.deduplication };
      if (
        !result ||
        result.error ||
        (this.requireFiles && (!Array.isArray(result.files) || !result.files.length))
      )
        throw Object.assign(
          Error(
            result?.error === 'export_directory_unavailable'
              ? '导出目录不可写，请修正目录后重试。'
              : '未生成导出文件，请检查本机连接后重试。',
          ),
          { tableError: true },
        );
      job.status = 'completed';
      this.progress({ ...job, rows: undefined, rowCount: job.rows.length });
      return job.export;
    } catch (error) {
      job.status = 'failed';
      job.reason = error.tableError
        ? error.message
        : '导出未完成，请检查本机桥、导出目录和已收集部分。';
      this.progress({ ...job, rows: undefined, rowCount: job.rows.length });
      throw error;
    } finally {
      this.jobs.delete(id);
    }
  }
}

export function taskTableAdapter(api, executor, bridge, consent) {
  const recordStep = async (task, action, work) => {
    const current = bridge(),
      started = Date.now(),
      scope = { taskId: task.id, generation: task.generation, stepId: crypto.randomUUID(), action };
    const report = (params) =>
      current?.request('extension.task_step', { ...scope, ...params }).catch(() => {});
    await report({ phase: 'start' });
    try {
      const value = await work();
      const unknown = value?.outcomeUnknown || ['unobserved', 'unverified'].includes(value?.effect);
      const failed = value?.blocked || value?.error || value?.exceptionDetails;
      await report({
        phase: unknown ? 'unknown' : failed ? 'failed' : 'succeeded',
        durationMs: Date.now() - started,
        ...(unknown || failed
          ? { errorCode: unknown ? 'operation_outcome_unknown' : 'execution_denied' }
          : {}),
      });
      return value;
    } catch (error) {
      await report({
        phase: 'failed',
        durationMs: Date.now() - started,
        errorCode: 'execution_denied',
      });
      throw error;
    }
  };
  const guard = async (workspace) => {
    const task = executor.tasks.get(workspace.taskId),
      tab = await api.tabs.get(workspace.tabId);
    if (
      !task ||
      task.revoked ||
      !task.silent ||
      !task.agentTabs.has(tab.id) ||
      executor.leases.get(tab.id) !== task.id ||
      tab.windowId !== workspace.windowId ||
      tab.groupId !== workspace.groupId
    )
      throw Object.assign(Error('工作页归属已变化'), { code: 'work_ownership_changed' });
    if (new URL(tab.url).origin !== workspace.origin)
      throw Object.assign(Error('工作页来源已变化'), { code: 'work_origin_changed' });
    if (task.policy.modeGeneration !== workspace.modeGeneration) throw Error('工作页授权已变化');
    const window = await api.windows.get(tab.windowId);
    if (tab.active && window.focused)
      throw Object.assign(Error('用户正在查看工作页，已暂停收集'), { code: 'work_page_focused' });
    return task;
  };
  const execute = async (workspace, func, args = []) => {
    const task = await guard(workspace);
    return recordStep(task, func === captureTables ? 'table.read' : 'page.parse', async () => {
      let timer;
      try {
        const result = await Promise.race([
          api.scripting.executeScript({ target: { tabId: workspace.tabId }, func, args }),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(Error('后台页面响应超时，保存已收部分')), 10000);
          }),
        ]);
        await guard(workspace);
        return result[0].result;
      } finally {
        clearTimeout(timer);
      }
    });
  };
  return {
    open: async (url, { incognito = false, resourceId = null } = {}) => {
      const current = bridge();
      if (!current) throw Error('本机桥未连接');
      const created = await current.request('extension.copilot.work_create', {
        url,
        incognito,
        ...(resourceId ? { resourceId } : {}),
      });
      try {
        await consent.synchronize(current);
        const task = executor.tasks.get(created.id);
        if (!task || task.revoked || !task.silent) throw Error('后台工作页授权未完成');
        const opened = await recordStep(task, 'new_tab', () =>
          executor.perform(task, {
            action: 'new_tab',
            taskId: task.id,
            generation: task.generation,
            modeGeneration: task.policy.modeGeneration,
            url,
            requestId: crypto.randomUUID(),
          }),
        );
        const tab = await api.tabs.get(opened.tabId);
        return {
          taskId: task.id,
          tabId: tab.id,
          windowId: tab.windowId,
          groupId: tab.groupId,
          origin: new URL(url).origin,
          modeGeneration: task.policy.modeGeneration,
        };
      } catch (error) {
        const local = executor.tasks.get(created.id);
        let cleanup;
        try {
          if (local)
            cleanup = await executor.release({
              taskId: local.id,
              generation: local.generation,
              closeAgentTabs: true,
            });
          await current.request('extension.stop', {
            taskId: created.id,
            generation: created.generation,
            ...(cleanup ? { cleanup } : {}),
          });
        } catch {}
        throw error;
      }
    },
    read: async (workspace, { minimumRows = 3, headers = [], selectors = [] } = {}) => {
      let previous = '',
        latest;
      for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
        await guard(workspace);
        const tab = await api.tabs.get(workspace.tabId);
        if (tab.status === 'complete') {
          latest = await execute(workspace, captureTables, [{ minimumRows, headers, selectors }]);
          const check = await execute(workspace, advanceTable, [{ kind: 'check', headers: [] }]);
          if (check.blocked) return { ...latest, blocked: check.blocked };
          const fingerprint = JSON.stringify(latest);
          if (fingerprint === previous && latest.tables.length) return latest;
          previous = fingerprint;
        }
        await sleep(800);
      }
      throw Error('后台页面未稳定，可能受浏览器节流影响');
    },
    readData: async (workspace, func, args = [], { render = false } = {}) => {
      // 中文注释：部分图表只在可见文档渲染；仅模拟任务页的文档状态，不激活标签或窗口。
      const rendering = async (enabled) => {
        const task = await guard(workspace);
        return recordStep(task, 'cdp.send', () =>
          executor.perform(task, {
            action: 'cdp.send',
            taskId: task.id,
            generation: task.generation,
            modeGeneration: workspace.modeGeneration,
            tabId: workspace.tabId,
            method: 'Emulation.setFocusEmulationEnabled',
            params: { enabled },
          }),
        );
      };
      if (render) await rendering(true);
      try {
        let result;
        for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
          await guard(workspace);
          const tab = await api.tabs.get(workspace.tabId);
          if (tab.status === 'complete') {
            result = await execute(workspace, func, args);
            if (
              result.error ||
              result.blocked ||
              result.ready === true ||
              result.results?.length ||
              result.series?.length ||
              result.records?.length
            )
              return result;
          }
          await sleep(800);
        }
        return result || { error: 'page_not_ready' };
      } finally {
        if (render)
          try {
            await rendering(false);
          } catch {
            /* 中文注释：撤销或接管后不再派发；工作页释放时也会分离调试会话。 */
          }
      }
    },
    submitQuery: async (workspace, { root, names }) => {
      const task = await guard(workspace),
        base = {
          taskId: task.id,
          generation: task.generation,
          modeGeneration: workspace.modeGeneration,
          tabId: workspace.tabId,
        };
      let snapshot,
        choices = [];
      for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
        await guard(workspace);
        snapshot = await recordStep(task, 'semantic_snapshot', () =>
          executor.perform(task, {
            ...base,
            action: 'semantic_snapshot',
            options: { mode: 'interactive', root, roles: ['button'], budget: 4000 },
          }),
        );
        choices = (snapshot.items || []).filter((item) => names.includes(item.name.trim()));
        if (choices.length) break;
        await sleep(800);
      }
      if (choices.length !== 1)
        throw Object.assign(Error('后台查询按钮无法唯一核实'), {
          code: 'query_control_unavailable',
        });
      await guard(workspace);
      const result = await recordStep(task, 'ref_click', () =>
        executor.perform(task, {
          ...base,
          action: 'ref_click',
          binding: snapshot.binding,
          snapshotId: snapshot.snapshotId,
          ref: choices[0].ref,
        }),
      );
      if (
        result.outcomeUnknown ||
        ['unobserved', 'unverified'].includes(result.effect) ||
        result.dialogOpened
      )
        throw Error('后台查询结果待核实，未重复派发');
    },
    advance: async (workspace, step) => {
      const plan = await execute(workspace, advanceTable, [{ ...step, inspect: true }]);
      if (plan.done || plan.blocked) return plan;
      const task = await guard(workspace),
        base = {
          taskId: task.id,
          generation: task.generation,
          modeGeneration: workspace.modeGeneration,
          tabId: workspace.tabId,
        };
      if (plan.control === 'scroll') {
        const expression =
          '(()=>{const box=document.querySelector(' +
          JSON.stringify(plan.root) +
          ');if(!box)return {blocked:true};box.scrollBy({top:Math.max(1,box.clientHeight*.8),behavior:"instant"});return {scrolled:true};})()';
        const result = await recordStep(task, 'scroll', () =>
          executor.perform(task, {
            ...base,
            action: 'cdp.send',
            method: 'Runtime.evaluate',
            params: { expression, returnByValue: true, userGesture: false, timeout: 1500 },
          }),
        );
        if (result.exceptionDetails || result.result?.value?.blocked)
          return { blocked: '滚动容器已变化，保存已收部分' };
        return { advanced: true };
      }
      const options = {
        mode: 'interactive',
        root: plan.root,
        query: plan.name,
        roles: ['button', 'link'],
        budget: 2000,
      };
      const snapshot = await recordStep(task, 'semantic_snapshot', () =>
        executor.perform(task, { ...base, action: 'semantic_snapshot', options }),
      );
      const candidates = (snapshot.items || []).filter(
        (item) => item.name.trim().toLowerCase() === plan.name.toLowerCase(),
      );
      if (candidates.length !== 1) return { blocked: '无法唯一核实分页或滚动目标，已停止' };
      const result = await recordStep(task, 'ref_click', () =>
        executor.perform(task, {
          ...base,
          action: 'ref_click',
          direction: 'down',
          binding: snapshot.binding,
          snapshotId: snapshot.snapshotId,
          ref: candidates[0].ref,
        }),
      );
      if (
        result.outcomeUnknown ||
        ['unobserved', 'unverified'].includes(result.effect) ||
        result.dialogOpened
      )
        return { blocked: '分页动作结果待核实，未重复派发' };
      return { advanced: true };
    },
    navigate: async (workspace, url) => {
      const task = await guard(workspace);
      return recordStep(task, 'navigate', () =>
        executor.perform(task, {
          action: 'navigate',
          taskId: task.id,
          generation: task.generation,
          modeGeneration: workspace.modeGeneration,
          tabId: workspace.tabId,
          url,
        }),
      );
    },
    close: async (workspace) => {
      const task = executor.tasks.get(workspace.taskId);
      if (task) {
        const cleanup = await executor.release({
          taskId: task.id,
          generation: task.generation,
          closeAgentTabs: true,
        });
        await bridge().request('extension.stop', {
          taskId: task.id,
          generation: task.generation,
          cleanup,
        });
        if (cleanup?.cleanupState !== 'succeeded') throw Error('清理待核实');
      }
    },
  };
}
