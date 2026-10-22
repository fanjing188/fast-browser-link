// 中文注释：列和数据均来自宿主合同；只写 textContent，不解释页面内容。
export function genericCell(value, language = 'zh') {
  if (value == null || value === '') return language.startsWith('en') ? 'Unknown' : '未知';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}
const fieldValue = (record, field) => (Object.hasOwn(record, field) ? record[field] : undefined);

export function renderGenericTable(doc, content, row, { command, clipboard } = {}) {
  const en = doc.documentElement.lang.startsWith('en'),
    language = en ? 'en' : 'zh',
    t = (zh, english) => (en ? english : zh),
    spec = row.result_view,
    records = row.result.records || [],
    state = (content._genericState ||= {
      query: '',
      sort: spec.primary,
      direction: 1,
      selected: new Set(),
    });
  const node = (tag, text) => {
    const value = doc.createElement(tag);
    if (text !== undefined) value.textContent = text;
    return value;
  };
  const label = (column) =>
    typeof column.label === 'string' ? column.label : column.label[language] || column.label.en;
  const toolbar = node('div');
  toolbar.className = 'actions';
  const search = node('input');
  search.type = 'search';
  search.value = state.query;
  search.placeholder = t('筛选记录', 'Filter records');
  search.setAttribute('aria-label', search.placeholder);
  const count = node('output');
  count.setAttribute('aria-live', 'polite');
  const notice = node('output');
  notice.setAttribute('role', 'status');
  const wrap = node('div');
  wrap.className = 'table-wrap';
  wrap.tabIndex = 0;
  wrap.setAttribute('aria-label', t('协作结果表格', 'Assist result table'));
  const table = node('table'),
    head = node('thead'),
    tr = node('tr'),
    body = node('tbody');
  table.append(node('caption', row.flow_name || row.title));
  const selectedHeading = node('th', t('选择', 'Select'));
  selectedHeading.scope = 'col';
  tr.append(selectedHeading);
  let visible = [];
  const drawRows = () => {
    visible = records
      .map((record, index) => ({ record, index }))
      .filter(({ record }) =>
        spec.columns.some(({ field }) =>
          genericCell(fieldValue(record, field), language)
            .toLowerCase()
            .includes(state.query.toLowerCase()),
        ),
      )
      .sort((a, b) => {
        const left = fieldValue(a.record, state.sort),
          right = fieldValue(b.record, state.sort);
        if (left == null || left === '') return right == null || right === '' ? 0 : 1;
        if (right == null || right === '') return -1;
        return (
          (typeof left === 'number' && typeof right === 'number'
            ? left - right
            : String(left).localeCompare(String(right))) * state.direction
        );
      });
    body.replaceChildren();
    for (const { record, index } of visible) {
      const line = node('tr'),
        cell = node('td'),
        box = node('input');
      box.type = 'checkbox';
      box.checked = state.selected.has(index);
      box.setAttribute(
        'aria-label',
        t('选择 ', 'Select ') + genericCell(fieldValue(record, spec.primary), language),
      );
      box.onchange = () => {
        if (box.checked) state.selected.add(index);
        else state.selected.delete(index);
        updateCount();
      };
      cell.append(box);
      line.append(cell);
      for (const { field } of spec.columns) {
        const value = node('td', genericCell(fieldValue(record, field), language));
        value.dataset.userContent = 'true';
        line.append(value);
      }
      body.append(line);
    }
    if (!visible.length) {
      const line = node('tr'),
        cell = node('td', t('没有匹配的记录', 'No matching records'));
      cell.colSpan = spec.columns.length + 1;
      line.append(cell);
      body.append(line);
    }
    updateCount();
  };
  const updateCount = () => {
    count.textContent = t(
      `显示 ${visible.length} 条 · 已选 ${state.selected.size} 条`,
      `${visible.length} shown · ${state.selected.size} selected`,
    );
    if (row.preview_truncated)
      count.textContent += t(
        ` · 预览 ${records.length} / 总 ${row.result_total_records} 条；完整文件见产物`,
        ` · Preview ${records.length} / ${row.result_total_records} total; see artifacts for complete files`,
      );
  };
  for (const column of spec.columns) {
    const th = node('th'),
      sort = node('button', label(column));
    th.scope = 'col';
    sort.type = 'button';
    const updateSort = () =>
      th.setAttribute(
        'aria-sort',
        state.sort === column.field ? (state.direction === 1 ? 'ascending' : 'descending') : 'none',
      );
    sort.onclick = () => {
      state.direction = state.sort === column.field ? -state.direction : 1;
      state.sort = column.field;
      for (const heading of head.querySelectorAll('th[aria-sort]'))
        heading.setAttribute('aria-sort', 'none');
      updateSort();
      drawRows();
    };
    updateSort();
    th.append(sort);
    tr.append(th);
  }
  const indices = () =>
    visible
      .filter(({ index }) => !state.selected.size || state.selected.has(index))
      .map(({ index }) => index);
  const button = (text, run) => {
    const value = node('button', text);
    value.type = 'button';
    value.onclick = async () => {
      value.disabled = true;
      try {
        await run();
      } catch {
        notice.textContent = t(
          '操作未完成，请检查本地连接后重试。',
          'Action failed. Check the local connection and retry.',
        );
      } finally {
        value.disabled = false;
      }
    };
    toolbar.append(value);
  };
  button(
    row.preview_truncated ? t('复制预览', 'Copy preview') : t('复制表格', 'Copy table'),
    async () => {
      await clipboard.writeText(
        [
          spec.columns.map(label).join('\t'),
          ...indices().map((index) =>
            spec.columns
              .map(({ field }) =>
                genericCell(fieldValue(records[index], field), language)
                  .replaceAll('\t', ' ')
                  .replaceAll('\n', ' '),
              )
              .join('\t'),
          ),
        ].join('\n'),
      );
      notice.textContent = t('已复制', 'Copied');
    },
  );
  const exportTable = async () => {
    const result = await command('export_results', { id: row.id, rows: indices() });
    if (result.error) throw Error(result.error);
    return result;
  };
  button(
    row.preview_truncated ? t('导出预览 CSV', 'Export preview CSV') : t('导出 CSV', 'Export CSV'),
    async () => {
      await exportTable();
      notice.textContent = t('已导出', 'Exported');
    },
  );
  button(
    row.preview_truncated
      ? t('预览加入工作篮', 'Add preview to basket')
      : t('加入工作篮', 'Add to basket'),
    async () => {
      const exported = await exportTable();
      await command('basket_add', { items: [{ type: 'table', value: exported.id }] });
      notice.textContent = t('已加入工作篮', 'Added to basket');
    },
  );
  search.oninput = () => {
    state.query = search.value;
    drawRows();
  };
  head.append(tr);
  table.append(head, body);
  wrap.append(table);
  content.append(search, count, wrap, toolbar, notice);
  drawRows();
}
