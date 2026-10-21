// Serialized into the company's browser module; keep this function self-contained.
export function installFileVersionsUi(ctx, { createElement: h, useEffect, useRef, useState }) {
  function coordinates(actionUrl) {
    try {
      const url = new URL(actionUrl, 'http://rufa.local/');
      const kind = url.pathname.endsWith('/api/present.open') ? 'present' : url.pathname.endsWith('/api/changes.open') ? 'change' : null;
      const sessionId = url.searchParams.get('sessionId'), seq = Number(url.searchParams.get('seq')), index = Number(url.searchParams.get('index'));
      return kind && sessionId && Number.isSafeInteger(seq) && seq >= 0 && Number.isSafeInteger(index) && index >= 0 ? { kind, sessionId, seq, index } : null;
    } catch { return null; }
  }
  const stamp = value => new Date(value).toLocaleString('zh-CN', { hour12: false });
  const shortStamp = value => new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  const labels = { '修改前': '智能体修改前', '修改后': '智能体修改后', '恢复前保留': '恢复前保留的文件', '恢复结果': '恢复后的文件' };
  // A real parent/child tree, not a chronological list decorated with branches.
  // Assign each subtree its own horizontal space. Iterative layout also handles
  // long histories without recursive stack growth; scrolling keeps cards legible.
  function treeLayout(rows, currentId) {
    const nodes = [], byId = new Map(), roots = [];
    for (const row of rows) {
      const parent = byId.get(row.parentId);
      const node = { ...row, parentId: parent?.id ?? null, children: [], depth: parent ? parent.depth + 1 : 0, span: 1 };
      nodes.push(node); byId.set(node.id, node);
      if (parent) parent.children.push(node); else roots.push(node);
    }
    for (let i = nodes.length - 1; i >= 0; i--) {
      if (nodes[i].children.length) nodes[i].span = nodes[i].children.reduce((sum, child) => sum + child.span, 0);
    }
    let cursor = 0;
    for (const root of roots) { root.start = cursor; cursor += root.span; }
    for (const node of nodes) {
      node.x = 16 + (node.start + node.span / 2) * 212; node.y = 16 + node.depth * 106;
      let start = node.start;
      for (const child of node.children) { child.start = start; start += child.span; }
    }
    const active = new Set(); let current = byId.get(currentId);
    while (current && !active.has(current.id)) { active.add(current.id); current = byId.get(current.parentId); }
    return { nodes, byId, active, width: Math.max(244, cursor * 212 + 32), height: nodes.reduce((height, node) => Math.max(height, node.y + 92), 108) };
  }
  function FileVersions({ actionUrl }) {
    const location = coordinates(actionUrl), identity = JSON.stringify(location), dialog = useRef(null), treeViewport = useRef(null), generation = useRef(0), comparisonRequest = useRef(0), historyRequest = useRef(0);
    const [history, setHistory] = useState(null), [open, setOpen] = useState(false), [tab, setTab] = useState('changes');
    const [selected, setSelected] = useState(null), [preview, setPreview] = useState(null), [ticket, setTicket] = useState(null);
    const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [historyLoading, setHistoryLoading] = useState(false);
    const [error, setError] = useState(''), [notice, setNotice] = useState('');
    async function request(action, input) {
      const result = await window.rufaAccount?.fileVersions?.(action, input);
      if (!result?.ok) throw new Error(result?.error?.message || '文件版本暂不可用，请重试。');
      return result.value;
    }
    async function refresh(verifyCurrent = true) {
      const turn = generation.current, attempt = ++historyRequest.current; setHistoryLoading(true);
      try {
        const value = await request('history', { ...location, ...(!verifyCurrent ? { summaryOnly: true } : {}) });
        if (turn !== generation.current || attempt !== historyRequest.current) return;
        setHistory(value); setSelected(value.versions?.[0]?.id ?? null); setError('');
      } catch (failure) { if (turn === generation.current && attempt === historyRequest.current) setError(failure.message); }
      finally { if (turn === generation.current && attempt === historyRequest.current) setHistoryLoading(false); }
    }
    useEffect(() => {
      ++generation.current; ++comparisonRequest.current;
      setHistory(null); setPreview(null); setTicket(null); setOpen(false); setError(''); setBusy(false);
      if (location) void refresh(false);
      return () => { ++generation.current; ++comparisonRequest.current; };
    }, [identity]);
    useEffect(() => {
      if (open && dialog.current && !dialog.current.open) dialog.current.showModal();
    }, [open]);
    useEffect(() => {
      const turn = generation.current, attempt = ++comparisonRequest.current;
      setPreview(null);
      if (!open || !selected) { setLoading(false); return; }
      setLoading(true);
      const node = tab === 'history' && history?.tree?.nodes?.find(row => row.id === selected);
      request('compare', { ...location, versionId: selected, ...(node && node.compareBeforeId !== undefined ? { beforeId: node.compareBeforeId } : {}) }).then(value => {
        if (turn === generation.current && attempt === comparisonRequest.current) setPreview(value);
      }, failure => {
        if (turn === generation.current && attempt === comparisonRequest.current) setError(failure.message);
      }).finally(() => {
        if (turn === generation.current && attempt === comparisonRequest.current) setLoading(false);
      });
    }, [open, selected, history, tab]);
    useEffect(() => {
      if (!open || tab !== 'history' || !treeViewport.current) return;
      const viewport = treeViewport.current;
      const node = [...viewport.querySelectorAll('[data-rufa-version-row]')].find(row => row.dataset.rufaVersionRow === selected);
      if (!node) return;
      const box = node.getBoundingClientRect(), frame = viewport.getBoundingClientRect();
      if (box.left < frame.left + 12 || box.right > frame.right - 12) viewport.scrollLeft += box.left - frame.left - (frame.width - box.width) / 2;
      if (box.top < frame.top + 12 || box.bottom > frame.bottom - 12) viewport.scrollTop += box.top - frame.top - (frame.height - box.height) / 2;
    }, [open, selected, tab, history]);
    if (!location || !window.rufaAccount?.fileVersions) return null;
    const versions = history?.versions ?? [], currentId = !busy && !historyLoading ? history?.tree?.currentId : null;
    const tree = treeLayout(history?.tree?.nodes ?? [], currentId);
    const current = tree.byId.get(selected) ?? versions.find(version => version.id === selected);
    const undo = versions.find(version => version.id === history?.undoVersionId);
    function chooseTab(next) {
      if (busy) return;
      setTab(next); setTicket(null); setError('');
      if (next === 'changes') setSelected(versions[0]?.id ?? null);
      else if (!tree.byId.has(selected)) setSelected(history?.tree?.currentId ?? tree.nodes.at(-1)?.id ?? null);
    }
    async function prepare(versionId, isUndo = false) {
      if (busy || !versionId) return;
      const turn = generation.current; setBusy(true); setError(''); setNotice('');
      try {
        const value = await request('prepareRestore', { ...location, versionId });
        if (turn === generation.current) setTicket({ ...value, isUndo });
      } catch (failure) { if (turn === generation.current) { setError(failure.message); setTicket(null); } }
      finally { if (turn === generation.current) setBusy(false); }
    }
    async function restore() {
      if (busy || !ticket) return;
      const turn = generation.current; setBusy(true); setError(''); setNotice('');
      try {
        await request('restore', { ticketId: ticket.ticketId });
        if (turn !== generation.current) return;
        setTicket(null); setNotice('已恢复。恢复前的文件也已保留，可以在历史版本中找回。');
        await refresh();
      } catch (failure) { if (turn === generation.current) { setError(failure.message); setTicket(null); } }
      finally { if (turn === generation.current) setBusy(false); }
    }
    const comparison = loading ? h('div', { className: 'rufa-version-empty', role: 'status' }, '正在整理文件改动…')
      : preview ? h('div', { 'data-rufa-version-diff': '' },
        h('div', { className: 'rufa-version-diff-heading' }, h('h3', null, preview.summary),
          current && h('span', null, `${stamp(current.createdAt)} 保存`)),
        preview.notice && h('p', { className: 'rufa-version-preview-note' }, preview.notice),
        ...(preview.changes ?? []).map((change, index) => h('section', { key: index, className: 'rufa-version-change' },
          h('h4', null, change.location), h('div', { className: 'rufa-version-comparison' },
            h('div', { className: 'rufa-version-before' }, h('strong', null, '修改前'), h('pre', null, change.before || '（空）')),
            h('div', { className: 'rufa-version-after' }, h('strong', null, '修改后'), h('pre', null, change.after || '（空）'))))),
        preview.truncated && h('p', { className: 'rufa-version-preview-note' }, '改动较多，这里仅展示部分内容；完整文件版本已保留。'))
      : h('div', { className: 'rufa-version-empty', role: 'status' }, historyLoading ? '正在读取文件版本…' : error ? '暂时无法显示改动' : '还没有保存的文件版本',
        !historyLoading && !error && h('p', null, '启用此功能后，智能体修改文件时会自动保留版本。'));
    function selectVersion(id, focus = false) {
      if (busy || !id) return;
      setSelected(id); setTicket(null); setError('');
      if (focus) [...(treeViewport.current?.querySelectorAll('[data-rufa-version-row]') ?? [])].find(row => row.dataset.rufaVersionRow === id)?.focus({ preventScroll: true });
    }
    const versionTree = h('section', { key: 'history', className: 'rufa-version-tree-section', 'aria-label': '文件版本分支树', 'aria-busy': busy || historyLoading },
      h('div', { className: 'rufa-version-tree-heading' }, h('div', null, h('h3', null, '文件的变化路线'),
        h('p', null, '从上往下看。恢复旧版本会产生新分支，原来的版本仍然保留。')),
        h('div', { className: 'rufa-version-tree-legend' }, h('span', { className: 'rufa-version-current-key' }, '当前路线'), h('span', null, '保留的版本'))),
      history?.tree?.notice && h('p', { className: 'rufa-version-tree-notice', 'data-rufa-version-current-notice': '' }, history.tree.notice),
      h('div', { ref: treeViewport, className: 'rufa-version-tree-viewport', tabIndex: 0, 'aria-label': '版本树，可滚动查看所有分支' },
        h('div', { className: 'rufa-version-tree-canvas', style: { width: tree.width, height: tree.height } },
          h('svg', { width: tree.width, height: tree.height, 'aria-hidden': 'true', className: 'rufa-version-tree-lines' },
            ...tree.nodes.filter(node => node.parentId).map(node => {
              const parent = tree.byId.get(node.parentId), top = parent.y + 76, middle = (top + node.y) / 2;
              return h('path', { key: node.id, 'data-rufa-version-edge': node.id, 'data-parent-version': parent.id,
                'data-restore-branch': node.kind === 'restored' ? 'true' : 'false',
                className: tree.active.has(node.id) ? 'rufa-version-edge-current' : '',
                d: `M ${parent.x} ${top} C ${parent.x} ${middle}, ${node.x} ${middle}, ${node.x} ${node.y}` });
            })),
          ...tree.nodes.map((version, index) => {
            const source = tree.byId.get(version.restoredFromId), isCurrent = currentId === version.id;
            const caption = version.kind === 'restored' ? `从版本 ${source?.number ?? tree.byId.get(version.parentId)?.number ?? ''} 恢复 · 新分支`
              : version.kind === 'uncertain' ? '状态待核对' : version.kind === 'backup' ? '恢复前保留'
                : !version.parentId ? '最初保存' : !version.canRestore ? '文件当时不存在' : labels[version.label] ?? version.label;
            return h('button', { key: version.id, type: 'button', 'data-rufa-version-row': version.id, 'data-current-version': String(isCurrent),
              className: `rufa-version-tree-node${isCurrent ? ' rufa-version-node-current' : ''}${version.kind === 'uncertain' ? ' rufa-version-node-uncertain' : ''}`,
              style: { left: version.x - 90, top: version.y }, 'aria-pressed': selected === version.id, disabled: busy,
              'aria-label': `版本 ${version.number}，${caption}${isCurrent ? '，当前使用' : ''}，${stamp(version.createdAt)}`,
              title: `${stamp(version.createdAt)} · ${version.canRestore ? `${Math.max(1, Math.round(version.size / 1024))} KB` : '文件当时不存在'}`,
              onClick: () => selectVersion(version.id), onKeyDown: event => {
                const id = event.key === 'ArrowLeft' ? version.parentId : event.key === 'ArrowRight' ? version.children.at(-1)?.id
                  : event.key === 'ArrowUp' ? tree.nodes[index - 1]?.id : event.key === 'ArrowDown' ? tree.nodes[index + 1]?.id
                    : event.key === 'Home' ? tree.nodes[0]?.id : event.key === 'End' ? tree.nodes.at(-1)?.id : null;
                if (id) { event.preventDefault(); selectVersion(id, true); }
              } },
              h('span', { className: 'rufa-version-node-title' }, h('strong', null, `版本 ${version.number}`),
                isCurrent && h('small', { title: '已核对打开面板或恢复完成时的文件内容' }, '当前使用')),
              h('span', { className: 'rufa-version-node-caption' }, caption), h('time', { dateTime: version.createdAt }, shortStamp(version.createdAt)));
          }))),
      h('p', { className: 'rufa-version-tree-hint', role: 'status' }, busy || historyLoading ? '正在更新版本路线…' : '点击一个版本，查看改动或恢复文件。'));
    const footer = ticket ? h('div', { className: 'rufa-version-confirmation' },
      h('div', null, h('strong', null, ticket.isUndo ? '确认撤销这次修改？' : '确认恢复到这个版本？'),
        h('p', null, `将使用 ${stamp(ticket.createdAt)} 保存的“${ticket.name}”。当前文件会先另存一个版本，之后仍可找回。`)),
      h('div', { className: 'rufa-version-footer-buttons' },
        h('button', { type: 'button', disabled: busy, onClick: () => setTicket(null) }, '取消'),
        h('button', { type: 'button', className: 'rufa-version-primary', 'data-rufa-version-confirm': '', disabled: busy, onClick: restore }, busy ? '正在恢复…' : '确认恢复')))
      : h('footer', { className: 'rufa-version-footer' },
        h('span', null, tab === 'history' ? '恢复会产生新分支，原来的文件也会保留。' : '想找回更早的文件？打开“历史版本”。'),
        tab === 'changes' ? undo?.canRestore && h('button', { type: 'button', 'data-rufa-version-undo': '', disabled: busy || historyLoading,
          onClick: () => prepare(undo.id, true) }, busy ? '正在准备…' : '撤销这次修改')
          : h('button', { type: 'button', className: 'rufa-version-primary', 'data-rufa-version-restore': '', disabled: busy || !current?.canRestore,
            onClick: () => prepare(selected) }, busy ? '正在准备…' : '恢复到这个版本'));
    return h('div', { className: 'rufa-file-versions', onClick: event => event.stopPropagation() },
      h('button', { type: 'button', 'data-rufa-versions-action': '', 'aria-label': '文件改动与历史版本', title: '历史版本', onClick: () => {
        setOpen(true); setTab('changes'); setTicket(null); setNotice(''); setSelected(versions[0]?.id ?? null); void refresh();
      } }, h('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false' },
        h('path', { d: 'M3 11a9 9 0 1 0 2.8-6.5L3 7' }), h('path', { d: 'M3 3v4h4M12 7v5l3 2' }))),
      open && h('dialog', { ref: dialog, 'data-rufa-versions-panel': '', className: 'rufa-version-dialog', 'aria-label': '文件改动与历史版本',
        onClose: () => { setOpen(false); setTicket(null); }, onCancel: event => { if (busy) event.preventDefault(); },
        onClick: event => { if (busy || event.target !== dialog.current) return; const r = dialog.current.getBoundingClientRect();
          if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.current.close(); } },
        h('div', { className: 'rufa-version-heading' },
          h('div', null, h('p', { className: 'rufa-version-eyebrow' }, '文件改动'), h('h2', null, history?.name ?? '文件')),
          h('button', { type: 'button', 'aria-label': '关闭历史版本', disabled: busy, onClick: () => dialog.current.close() }, '×')),
        h('div', { role: 'tablist', 'aria-label': '文件版本视图', className: 'rufa-version-tabs' },
          ...[['changes', '本次改动'], ['history', '历史版本']].map(([value, label]) => h('button', { key: value, type: 'button', role: 'tab',
            'data-rufa-version-tab': value, 'aria-selected': tab === value, disabled: busy, onClick: () => chooseTab(value) }, label))),
        (error || notice || history?.notice) && h('p', { role: error ? 'alert' : 'status', 'data-rufa-version-notice': '', className: `rufa-version-status ${error ? 'rufa-version-error' : 'rufa-version-success'}` }, error || notice || history.notice),
        h('div', { className: `rufa-version-body${tab === 'history' && versions.length ? ' rufa-version-with-history' : ''}`, role: 'tabpanel' },
          tab === 'history' && tree.nodes.length ? [versionTree, h('div', { className: 'rufa-version-detail', key: 'details' },
            h('div', { className: 'rufa-version-selected-label' }, `已选中版本 ${current?.number ?? ''}`,
              current?.kind === 'restored' && h('span', null, '与恢复前的文件比较')), comparison)] : comparison),
        footer,
        h('details', { className: 'rufa-version-help' }, h('summary', null, '版本保存说明'),
          h('p', null, '文件版本只保存在当前账号的这台电脑上。', history?.coverage ?? '这里只显示当前账号在本机保存的文件版本。'))));
  }
  for (const name of ['deliverables.file.actions', 'deliverables.review.file.actions']) {
    ctx.slots.inject(name, () => ctx.slots.register({ name, id: 'rufa-file-versions', order: 20 }, FileVersions));
  }
}
