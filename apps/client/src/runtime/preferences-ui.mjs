// Serialized into the existing brand client; use only supplied React/native UI.
export function installWorkPreferencesUi(ctx, { createElement: h, useEffect, useRef, useState, Input, Button }) {
  const bridge = window.rufaAccount;
  const categories = { communication: '沟通方式', spreadsheet: '表格', presentation: '演示文稿', document: '文档', delivery: '交付', general: '其他' };
  const invoke = async (action, input) => {
    const result = await bridge?.preferences?.(action, input);
    if (!result?.ok) throw new Error(result?.error?.message || '工作偏好暂不可用，请重新打开工作台。');
    return result.value;
  };
  const styles = `
    .rufa-preferences{max-width:780px;display:flex;flex-direction:column;gap:18px;padding:4px 0 24px;color:var(--dsw-alias-label-primary)}
    .rufa-pref-heading{margin:0;font-size:20px;font-weight:600}.rufa-pref-help{margin:4px 0 0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.6}
    .rufa-pref-bar,.rufa-pref-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.rufa-pref-bar{justify-content:space-between}
    .rufa-pref-card{padding:16px;border:1px solid var(--dsw-alias-border-default,#ffffff20);border-radius:12px;background:var(--dsw-alias-background-secondary,transparent)}
    .rufa-pref-card h3{font-size:14px;margin:0 0 7px}.rufa-pref-text{font-size:14px;line-height:1.7;margin:6px 0;white-space:pre-wrap;overflow-wrap:anywhere}
    .rufa-pref-meta{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.7;overflow-wrap:anywhere}.rufa-pref-card[aria-disabled=true]{opacity:.65}
    .rufa-pref-field{display:flex;flex-direction:column;gap:6px;font-size:13px;margin-bottom:12px}.rufa-pref-field textarea,.rufa-preferences select{font:inherit;color:inherit;background:var(--dsw-alias-background-primary,#202020);border:1px solid var(--dsw-alias-border-default,#ffffff30);border-radius:8px;padding:8px;max-width:100%}.rufa-pref-field textarea{min-height:96px;resize:vertical;line-height:1.6}
    .rufa-pref-error{color:var(--dsw-alias-status-error,#ef9292);font-size:13px;white-space:pre-wrap}.rufa-pref-notice{font-size:13px;color:var(--dsw-alias-label-secondary)}
    .rufa-pref-conflict{border-color:var(--dsw-alias-status-warning,#a68a49)}.rufa-pref-compare{display:grid;grid-template-columns:1fr 1fr;gap:12px}
    .rufa-pref-toggle{display:flex;gap:10px;align-items:center;font-size:14px}.rufa-pref-toggle input{width:17px;height:17px;accent-color:#6fa3ff}
    .rufa-pref-toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:10000;display:flex;align-items:center;gap:12px;max-width:calc(100vw - 40px);padding:12px 16px;border:1px solid #7775;border-radius:12px;background:#272727;color:#f1f1f1;box-shadow:0 6px 30px #0005;font:13px/1.5 sans-serif}.rufa-pref-toast button{background:none;border:0;color:#a7c9ff;font:inherit;cursor:pointer;padding:2px 4px}
    @media(max-width:680px){.rufa-pref-compare{grid-template-columns:1fr}.rufa-pref-card{padding:12px}}
  `;
  function PreferencesSection() {
    const [data, setData] = useState(null), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
    const [filter, setFilter] = useState('all'), [draft, setDraft] = useState(null), [clearRevision, setClearRevision] = useState(null);
    const mounted = useRef(false), working = useRef(false), generation = useRef(0);
    const refresh = async () => {
      const current = ++generation.current;
      try { const value = await invoke('snapshot'); if (mounted.current && current === generation.current) setData(value); }
      catch (error) { if (mounted.current && current === generation.current) setMessage(error.message); }
    };
    useEffect(() => {
      mounted.current = true; void refresh(); let timer;
      const off = bridge?.onPreferencesChanged?.(() => { clearTimeout(timer); timer = setTimeout(() => { void refresh(); }, 80); });
      return () => { mounted.current = false; generation.current++; clearTimeout(timer); off?.(); };
    }, []);
    const run = async (action, input, success) => {
      if (working.current) return; working.current = true; setBusy(true); setMessage('');
      try { await invoke(action, input); if (mounted.current) { success?.(); await refresh(); } }
      catch (error) { if (mounted.current) { setMessage(error.message); await refresh(); } }
      finally { working.current = false; if (mounted.current) setBusy(false); }
    };
    const button = (label, onClick, disabled = false, extra = {}) => h(Button, { type: 'button', onClick, disabled: busy || disabled, ...extra }, label);
    const date = value => new Date(value).toLocaleString();
    const scopeName = entry => entry.scope === 'account' ? '通用' : entry.projectName || '项目偏好';
    const localProject = entry => entry.scope === 'account' || data?.projects.some(row => row.projectRef === entry.projectRef);
    const source = entry => entry.source && ctx.get('sessions')?.list?.getSnapshot?.().byId?.[entry.source.sessionId];
    const fields = entry => {
      const { version, createdAt, updatedAt, deletedAt, ...value } = entry; return value;
    };
    const edit = entry => setDraft({ entry: fields(entry), version: entry.version });
    const setField = (key, value) => setDraft(previous => ({ ...previous, entry: { ...previous.entry, [key]: value } }));
    const status = !data ? '正在读取…' : ({ syncing: '正在同步', synced: '已同步', pending: '等待同步', conflict: '有冲突待处理', offline: '本机可用，等待连接' })[data.status] || '等待同步';
    const summary = part => part.settings ? part.settings.enabled ? '工作偏好开启' : '工作偏好关闭'
      : (part.entries || []).map(row => `${row.topic}：${row.deletedAt ? '已删除' : row.text}`).join('\n') || '无记录';
    const rows = (data?.entries || []).filter(row => !row.deletedAt && (filter === 'all' || filter === 'account' ? filter === 'all' || row.scope === 'account' : row.projectRef === filter));
    return h('section', { className: 'rufa-preferences', 'data-rufa-preferences': '', 'aria-busy': busy },
      h('div', null, h('h2', { className: 'rufa-pref-heading' }, '工作偏好'), h('p', { className: 'rufa-pref-help' }, '保存常用工作方式和输出格式。偏好不能代替当前要求或操作授权。')),
      h('div', { className: 'rufa-pref-card rufa-pref-bar' },
        h('label', { className: 'rufa-pref-toggle' }, h('input', { type: 'checkbox', checked: data?.settings.enabled ?? false, disabled: busy || !data,
          onChange: event => run('mutate', { action: 'settings', enabled: event.target.checked, expectedVersion: data.settings.version }) }), '使用工作偏好'),
        h('span', { className: 'rufa-pref-meta', role: 'status' }, status, data?.pendingCount ? ` · ${data.pendingCount}项待同步` : ''),
        button('同步', () => run('sync'), !data)),
      h('p', { className: 'rufa-pref-help' }, '关闭后，从下次请求起停止使用；已有记录保留。修改先保存在当前账号的本机缓存，连接恢复后同步。'),
      message && h('p', { className: 'rufa-pref-error', role: 'alert' }, message),
      ...(data?.conflicts || []).map(item => h('div', { className: 'rufa-pref-card rufa-pref-conflict', key: item.id },
        h('h3', null, item.code === 'SERVER_REJECTED' ? '这项修改未被服务器接受' : '这项偏好在其他设备上发生了变化'),
        h('div', { className: 'rufa-pref-compare' }, h('div', null, h('strong', null, '本机'), h('p', { className: 'rufa-pref-text' }, summary(item.local))),
          h('div', null, h('strong', null, '云端'), h('p', { className: 'rufa-pref-text' }, summary(item.cloud)))),
        h('div', { className: 'rufa-pref-actions' }, button('保留本地', () => run('resolve', { id: item.id, choice: 'local' })), button('采用云端', () => run('resolve', { id: item.id, choice: 'cloud' }))))),
      h('div', { className: 'rufa-pref-bar' }, h('label', { className: 'rufa-pref-actions' }, '范围', h('select', { value: filter, onChange: event => setFilter(event.target.value), 'aria-label': '偏好范围筛选' },
        h('option', { value: 'all' }, '全部'), h('option', { value: 'account' }, '通用'), ...(data?.projects || []).map(row => h('option', { key: row.projectRef, value: row.projectRef }, row.projectName)))),
        button('添加偏好', () => setDraft({ version: 0, entry: { id: crypto.randomUUID(), scope: 'account', category: 'general', topic: '', text: '', enabled: true } }), !data)),
      draft && h('form', { className: 'rufa-pref-card', onSubmit: event => { event.preventDefault(); void run('mutate', { action: 'put', entry: draft.entry, expectedVersion: draft.version }, () => setDraft(null)); } },
        h('h3', null, draft.version ? '编辑偏好' : '添加偏好'),
        h('label', { className: 'rufa-pref-field' }, '适用范围', h('select', { value: draft.entry.scope === 'account' ? 'account' : draft.entry.projectRef,
          onChange: event => setDraft(previous => { const { projectRef, projectName, ...entry } = previous.entry; const project = data.projects.find(row => row.projectRef === event.target.value);
            return { ...previous, entry: { ...entry, scope: project ? 'project' : 'account', ...(project ? { projectRef: project.projectRef, projectName: project.projectName } : {}) } }; }), disabled: busy },
          h('option', { value: 'account' }, '通用'), ...data.projects.map(row => h('option', { key: row.projectRef, value: row.projectRef }, row.projectName)))),
        h('label', { className: 'rufa-pref-field' }, '类别', h('select', { value: draft.entry.category, onChange: event => setField('category', event.target.value), disabled: busy },
          ...Object.entries(categories).map(([value, title]) => h('option', { key: value, value }, title)))),
        h('label', { className: 'rufa-pref-field' }, '主题', h(Input, { value: draft.entry.topic, onChange: event => setField('topic', event.target.value), maxLength: 80, required: true, disabled: busy, placeholder: '例如：表格字体' })),
        h('label', { className: 'rufa-pref-field' }, '偏好内容', h('textarea', { value: draft.entry.text, onChange: event => setField('text', event.target.value), maxLength: 400, required: true, disabled: busy, placeholder: '例如：表格默认使用微软雅黑，标题加粗。' })),
        h('div', { className: 'rufa-pref-actions' }, h(Button, { type: 'submit', variant: 'primary', disabled: busy }, '保存'), button('取消', () => setDraft(null)))),
      !rows.length && data && h('p', { className: 'rufa-pref-notice' }, '这个范围还没有工作偏好。可以手动添加，或在聊天中明确要求记住某项工作习惯。'),
      ...rows.map(entry => h('article', { className: 'rufa-pref-card', key: entry.id, 'aria-disabled': !entry.enabled },
        h('h3', null, entry.topic), h('div', { className: 'rufa-pref-meta' }, scopeName(entry), ' · ', categories[entry.category], entry.enabled ? '' : ' · 已暂停', localProject(entry) ? '' : ' · 未绑定本机项目'),
        h('p', { className: 'rufa-pref-text' }, entry.text),
        h('div', { className: 'rufa-pref-actions' }, button('编辑', () => edit(entry), !localProject(entry)),
          button(entry.enabled ? '暂停' : '启用', () => run('mutate', { action: 'put', entry: { ...fields(entry), enabled: !entry.enabled }, expectedVersion: entry.version }), !localProject(entry)),
          button('删除', () => run('mutate', { action: 'delete', id: entry.id, expectedVersion: entry.version }))),
        h('details', { className: 'rufa-pref-meta' }, h('summary', null, '来源与日期'), h('div', null, entry.source ? source(entry)?.title ? `来自聊天：${source(entry).title}` : '来自之前的聊天' : '手动添加'),
          source(entry) && button('打开来源聊天', () => ctx.get('uiWorkspace')?.openSession(entry.source.sessionId)),
          h('div', null, `创建：${date(entry.createdAt)}`), h('div', null, `更新：${date(entry.updatedAt)}`)))),
      h('details', { className: 'rufa-pref-card' }, h('summary', null, '近期修改与撤销'), ...(data?.changes || []).map(change => h('div', { key: change.id, style: { marginTop: 12 } },
        h('span', { className: 'rufa-pref-meta' }, date(change.createdAt), ' · ', ({ put: '保存', delete: '删除', settings: '开关', clear: '清空', undo: '撤销' })[change.kind] || '更新'),
        h('p', { className: 'rufa-pref-text' }, summary(change.after)), button('撤销', () => run('mutate', { action: 'undo', changeId: change.id }), !change.canUndo)))),
      h('div', { className: 'rufa-pref-actions' }, clearRevision === null ? button('清空全部偏好', () => setClearRevision(data.revision), !data)
        : h('div', { className: 'rufa-pref-card' }, h('p', { className: 'rufa-pref-text' }, '确认清空全部通用和项目偏好？此操作也会同步到其他设备。主开关保持不变。'),
          h('div', { className: 'rufa-pref-actions' }, button('确认清空', () => run('mutate', { action: 'clear', expectedRevision: clearRevision }, () => setClearRevision(null))), button('取消', () => setClearRevision(null))))));
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'rufa-work-preferences', order: -5, label: () => '工作偏好' }, PreferencesSection));
  ctx.effect(() => {
    const style = document.createElement('style'); style.textContent = styles; document.head.append(style);
    let toast, timer, active = true;
    const clear = () => { clearTimeout(timer); toast?.remove(); toast = null; };
    const off = bridge?.onPreferencesChanged?.(notice => {
      if (!active || !notice?.changeId || typeof notice.message !== 'string') return; clear();
      toast = document.createElement('div'); toast.className = 'rufa-pref-toast'; toast.setAttribute('role', 'status');
      const label = document.createElement('span'); label.textContent = notice.message;
      const undo = document.createElement('button'); undo.type = 'button'; undo.textContent = '撤销';
      undo.addEventListener('click', async () => {
        undo.disabled = true;
        try { await invoke('mutate', { action: 'undo', changeId: notice.changeId }); clear(); }
        catch (error) { label.textContent = error.message; undo.remove(); }
      });
      const close = document.createElement('button'); close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', '关闭提示'); close.onclick = clear;
      toast.append(label, undo, close); document.body.append(toast); timer = setTimeout(clear, 8000);
    });
    return () => { active = false; off?.(); clear(); style.remove(); };
  });
}
