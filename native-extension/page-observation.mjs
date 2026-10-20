// 中文注释：等待只扫描有界主文档，复用语义上下文的可见性、脱敏、修订及身份，不创建操作引用。
export function observePage(context, options) {
  const { doc, binding, scan, visible, read, revision } = context;
  const selector = options?.selector;
  if (typeof selector !== 'string' || !selector || selector.length > 512)
    throw Error('INVALID_PARSE_OPTIONS');
  // 中文注释：先验证 CSS 语法；只返回固定错误，不返回选择器或页面异常原文。
  try {
    doc.createElement('div').matches(selector);
  } catch {
    throw Error('INVALID_PARSE_OPTIONS');
  }
  if (!doc.body) throw Error('PAGE_NOT_READY');
  const epoch = revision(),
    coverage = { scanned: 0, skippedFrames: 0, traversalComplete: true },
    text = [];
  let complete = true,
    totalChars = 0;
  for (const node of scan(doc.body, false, coverage)) {
    if (coverage.scanned >= 20000) {
      complete = false;
      break;
    }
    coverage.scanned++;
    if (!node.matches(selector) || !visible(node, false)) continue;
    if (text.length >= 1000) {
      complete = false;
      break;
    }
    // 中文注释：与 extract 文本字段一致，不读取表单输入值；每个匹配的文本上限沿用 4096。
    if (node.matches('input,textarea,select,[contenteditable="true"]')) text.push(null);
    else {
      const value = read(node);
      totalChars += value.text.length;
      if (totalChars > 12000) {
        complete = false;
        break;
      }
      text.push(
        value.truncated || value.text.includes('[redacted]') || !value.text.trim()
          ? null
          : value.text,
      );
    }
  }
  if (revision() !== epoch) throw Error('DOCUMENT_CHANGED');
  return { count: text.length, text, complete, binding };
}

// 中文注释：同一截止覆盖排队、探测和最终解析；超时只停止本地等待，不声称取消底层 CDP。
export function createPageWait(options, check, pending) {
  const w = options?.wait;
  if (
    !w ||
    typeof w !== 'object' ||
    Array.isArray(w) ||
    Object.keys(w).some(
      (key) => !['state', 'text', 'count', 'deadlineMs', 'intervalMs'].includes(key),
    ) ||
    typeof options.selector !== 'string' ||
    !options.selector ||
    options.selector.length > 512 ||
    !['present', 'absent', 'text', 'count', 'stable'].includes(w.state) ||
    !Number.isFinite(w.deadlineMs) ||
    w.deadlineMs > Date.now() + 60000 ||
    !Number.isFinite(w.intervalMs) ||
    w.intervalMs < 50 ||
    w.intervalMs > 2000 ||
    (w.state === 'text' && (typeof w.text !== 'string' || w.text.length > 12000)) ||
    (w.state === 'count' && (!Number.isSafeInteger(w.count) || w.count < 0))
  )
    throw Error('INVALID_PARSE_OPTIONS');
  const deadline = performance.now() + Math.max(0, w.deadlineMs - Date.now());
  const expired = Symbol('wait expired');
  let active = true,
    last = null,
    stable = 0,
    settled = false,
    reading = false;
  const slot = {};
  const release = () => {
    if (settled && !reading) pending.delete(slot);
  };
  const guard = () => {
    check();
    if (!active || performance.now() >= deadline) throw expired;
  };
  const bounded = async (work) => {
    guard();
    let timer, control;
    try {
      return await Promise.race([
        Promise.resolve().then(() => {
          guard();
          return work();
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(expired), Math.max(0, deadline - performance.now()));
          control = setInterval(() => {
            try {
              guard();
            } catch (error) {
              reject(error);
            }
          }, 20);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      clearInterval(control);
    }
  };
  const timedOut = () => ({
    satisfied: false,
    timed_out: true,
    last_observation: last && { count: last.count, text: last.text, complete: last.complete },
    coverage: { complete: false },
    reason: 'deadline_reached',
  });
  const matches = (o, n) =>
    o.complete === true &&
    ((w.state === 'present' && o.count > 0) ||
      (w.state === 'absent' && o.count === 0) ||
      (w.state === 'count' && o.count === w.count) ||
      (w.state === 'text' && o.text.some((value) => (value || '').includes(w.text))) ||
      (w.state === 'stable' && o.count > 0 && n >= 2));
  const read = async (fn, action, readOptions) => {
    guard();
    reading = true;
    const promise = Promise.resolve().then(() => {
      guard();
      return fn(action, readOptions);
    });
    const finish = () => {
      reading = false;
      release();
    };
    promise.then(finish, finish);
    const result = await bounded(() => promise);
    guard();
    return result;
  };
  return {
    guard,
    async run(work) {
      try {
        guard();
        // 中文注释：准入先于屏障/同页队列，排队与挂起读取都占唯一名额，直到真实工作结算。
        if (pending.size) throw Error('OBSERVATION_CAPACITY');
        pending.add(slot);
        const promise = Promise.resolve().then(() => {
          guard();
          return work();
        });
        const finish = () => {
          settled = true;
          release();
        };
        promise.then(finish, finish);
        return await bounded(() => promise);
      } catch (error) {
        if (error === expired) return timedOut();
        throw error;
      } finally {
        active = false;
      }
    },
    async poll(fn) {
      try {
        while (true) {
          const observed = await read(fn, 'page.observe', { selector: options.selector });
          stable = JSON.stringify(observed) === JSON.stringify(last) ? stable + 1 : 0;
          last = observed;
          if (matches(observed, stable)) {
            const page = await read(fn, 'page.parse', {
              sections: [],
              budget: 12000,
              schema: {
                record: options.selector,
                fields: { text: { selector: ':scope', type: 'text' } },
              },
            });
            const final = {
              count: page.records.length,
              text: page.records.map((row) => row.fields.text ?? null),
              complete: page.coverage?.complete === true,
            };
            const same = JSON.stringify(page.binding) === JSON.stringify(observed.binding);
            const unchanged =
              final.count === observed.count &&
              final.complete === observed.complete &&
              JSON.stringify(final.text) === JSON.stringify(observed.text);
            const satisfied = same && matches(final, unchanged ? stable : 0);
            return {
              satisfied,
              timed_out: false,
              last_observation: final,
              coverage: page.coverage,
              reason: satisfied ? null : 'condition_changed',
            };
          }
          let wake;
          try {
            await bounded(
              () =>
                new Promise((resolve) => {
                  wake = setTimeout(
                    resolve,
                    Math.min(w.intervalMs, Math.max(0, deadline - performance.now())),
                  );
                }),
            );
          } finally {
            clearTimeout(wake);
          }
        }
      } catch (error) {
        if (error === expired) return timedOut();
        throw error;
      }
    },
  };
}
