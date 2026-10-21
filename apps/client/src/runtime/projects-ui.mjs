// Serialized into the pinned native workspace module by projects-runtime.mjs.
// The module's React, primitives, navigation lifetime and native row components
// remain the owners; no independent conversation or persistence implementation.
export function rufaProjectRank(workspace, summaries) {
  // Registry updatedAt also changes when an unused blank is detached. Only
  // creation and native session activity should move a project in the list.
  return Math.max(Date.parse(workspace.createdAt) || 0,
    ...workspace.sessionIds.map(id => summaries[id]?.updatedAt ?? 0));
}

export function rufaProjectViewOptions({ archivedFilter, onArchivedFilterPick }) {
  const { createElement: h, useState } = react;
  const { Menu, Button, IconSlidersTwoOutlineRegular } = _deepseek_ai_dsh_client_ui_primitives;
  const [open, setOpen] = useState(false);
  return h(Menu, { open, onClose: () => setOpen(false), selectedId: archivedFilter, portal: true,
    items: [{ id: 'default', label: '隐藏归档会话' }, { id: 'show', label: '显示归档会话' }, { id: 'only', label: '仅看归档会话' }],
    onSelect: id => { onArchivedFilterPick(id); setOpen(false); },
    anchor: h(Button, { variant: 'ghost', 'aria-label': '会话显示选项', onClick: () => setOpen(value => !value) }, h(IconSlidersTwoOutlineRegular, { size: 16 })) });
}

export async function rufaOpenIndependent(options, beforeOpen) {
  const navigation = AbortSignal.any([this.ctx.layout.beginNavigation(), this.lifetime.signal]);
  const { agentPreset, ...draft } = options ?? {};
  const initializeDraft = options !== undefined && (draft.prompt !== undefined || draft.clearPreviousDraft === true);
  let sessionId;
  try { sessionId = await this.sessions.create(agentPreset === undefined ? {} : { agentPreset }); }
  catch (error) {
    if (!navigation.aborted) this.notify({ kind: 'createFailed', message: creationFailureMessage(error) });
    throw error;
  }
  if (navigation.aborted) return;
  this.replaceMain(sessionId, navigation, 'reveal', initializeDraft ? id => {
    const binding = this.sessions.binding(id);
    if (binding === undefined) this.draftPreparationFailed();
    this.prepareDraft(binding, draft);
  } : beforeOpen);
}

export function rufaStartSession(workspaceId, options) {
  if (workspaceId === undefined) {
    void this.rufaOpenIndependent(options).catch(reason => console.warn('new session failed:', reason));
    return;
  }
  const { agentPreset, ...draft } = options ?? {};
  const draftOptions = options === undefined ? undefined : draft;
  const initializeDraft = draftOptions !== undefined && (draftOptions.prompt !== undefined || draftOptions.clearPreviousDraft === true);
  void (draftOptions === undefined ? this.openWorkspaceSession(workspaceId, undefined, undefined)
    : this.openWorkspace(workspaceId, initializeDraft ? id => {
      const binding = this.sessions.binding(id);
      if (binding === undefined) this.draftPreparationFailed();
      this.prepareDraft(binding, draftOptions);
    } : undefined, agentPreset === undefined ? {} : { agentPreset }))
    .catch(reason => console.warn('new session failed:', reason));
}

export async function rufaRestoreSelection(workspaces, sessions) {
  const saved = this.selection.getSnapshot();
  if (saved.subagentAddress !== undefined) {
    this.replaceMain(saved.subagentAddress, this.lifetime.signal, 'preserve');
    return;
  }
  const summary = saved.sessionId === undefined ? undefined : sessions.byId[saved.sessionId];
  if (summary !== undefined && !workspaces.archivedSessionIds.includes(summary.id)) {
    // Read the original cold Session; restoring it neither creates a new Agent
    // nor rewrites its cwd/preset/draft. Creation is reserved for explicit New.
    this.replaceMain(summary.id, this.lifetime.signal, 'preserve');
    return;
  }
  const members = new Set(workspaces.items.flatMap(item => item.sessionIds));
  const blank = sessions.ids.find(id => sessions.byId[id]?.blank === true
    && !members.has(id) && !workspaces.archivedSessionIds.includes(id));
  const navigation = AbortSignal.any([this.ctx.layout.beginNavigation(), this.lifetime.signal]);
  const sessionId = blank ?? await this.sessions.create({});
  if (!navigation.aborted) this.replaceMain(sessionId, navigation, 'preserve');
}

export function rufaProjectPickFlow({ t, open, anchorRef, useWorkspaces, createWorkspace,
  useDirectoryFlow, renderDirectoryFlow, onPick, onClose, addOnly = false,
  onBusyChange, side = 'bottom', selectedId }) {
  const { createElement: h, useState, useEffect, useRef, useCallback } = react;
  const { Button, Modal, Menu, Tooltip, IconPlusOutlineRegular, IconFolderCloseRegular, IconCloseOutlineRegular } = _deepseek_ai_dsh_client_ui_primitives;
  const snapshot = useWorkspaces(state => state), flowAvailable = useDirectoryFlow(value => value);
  const [dialogOpen, setDialogOpen] = useState(false), [browseOpen, setBrowseOpen] = useState(false);
  const [title, setTitle] = useState(''), [error, setError] = useState('');
  const [automatic, setAutomatic] = useState(true), [folders, setFolders] = useState([]), [references, setReferences] = useState([]);
  const [referencesOpen, setReferencesOpen] = useState(false), picking = useRef('work');
  const [pending, setPending] = useState(false), locked = useRef(false);
  const pickerActive = useRef(false), busy = pending || browseOpen;
  const getAnchorRect = useCallback(() => anchorRef?.current?.getBoundingClientRect() ?? null, [anchorRef]);
  const begin = useCallback(() => {
    onClose(); setError(''); setTitle(''); setAutomatic(true); setFolders([]); setReferences([]); setReferencesOpen(false); setDialogOpen(true);
  }, [onClose]);
  useEffect(() => { onBusyChange?.(dialogOpen || browseOpen || pending); }, [dialogOpen, browseOpen, pending, onBusyChange]);
  const direct = addOnly;
  useEffect(() => { if (open && direct && !dialogOpen && !pending) begin(); }, [open, direct, dialogOpen, pending, begin]);
  const close = () => { if (locked.current || pickerActive.current) return; setDialogOpen(false); setBrowseOpen(false); setError(''); };
  const submit = async event => {
    event?.preventDefault();
    if (locked.current || pickerActive.current) return;
    if (!title.trim()) { setError('请输入项目名称。'); return; }
    if (!automatic && !folders.length) { setError('请选择项目文件夹，或勾选自动创建。'); return; }
    locked.current = true; setPending(true); setError('');
    try {
      const workspace = await createWorkspace({ title: title.trim(), path: automatic ? '' : folders[0],
        referencePaths: [...(automatic ? [] : folders.slice(1)), ...references] });
      setDialogOpen(false); onClose(); onPick(workspace.workspaceId);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { locked.current = false; setPending(false); }
  };
  const none = '::rufa-no-project';
  const items = [{ id: none, label: '无项目' }, ...snapshot.items.map(item => ({ id: item.workspaceId, label: item.title, icon: h(IconFolderCloseRegular, { size: 16 }) }))];
  const add = { id: '::rufa-add-project', label: '新建项目', icon: h(IconPlusOutlineRegular, { size: 16 }) };
  const openPicker = kind => {
    if (locked.current || pickerActive.current || !flowAvailable || kind === 'work' && automatic) return;
    pickerActive.current = true; picking.current = kind; setBrowseOpen(true); setError('');
  };
  const finishPicker = () => {
    if (!pickerActive.current) return false;
    pickerActive.current = false; setBrowseOpen(false); return true;
  };
  const pathKey = path => path.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
  const folderName = path => path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || path;
  const folderList = (paths, kind, disabled) => h('div', {
    className: 'rufa-project-folders', 'aria-disabled': disabled, 'aria-label': kind === 'work' ? '自定义项目文件夹' : '参考文件夹',
    ...(kind === 'work' ? { 'data-rufa-project-folders': '' } : { 'data-rufa-project-reference-folders': '' }),
    onClick: () => { if (!disabled) openPicker(kind); },
  }, paths.map((path, index) => h('div', { key: path, className: 'rufa-project-folder', title: path,
    ...(kind === 'work' ? { 'data-rufa-project-folder': '' } : { 'data-rufa-project-reference-folder': '' }) },
    h('span', { className: 'rufa-project-folder-icon' }, h(IconFolderCloseRegular, { size: 20 })),
    h('span', { className: 'rufa-project-folder-name' }, folderName(path)),
    h('span', { className: 'rufa-project-folder-tag' }, kind === 'work' && index === 0 ? '工作文件夹' : '参考'),
    h('button', { type: 'button', className: 'rufa-project-icon', disabled, 'data-rufa-project-remove': kind,
      'aria-label': `移除${folderName(path)}`, onClick: event => {
        event.stopPropagation(); (kind === 'work' ? setFolders : setReferences)(values => values.filter(value => value !== path));
      } }, h(IconCloseOutlineRegular, { size: 16 })))),
    h('button', { type: 'button', disabled: disabled || !flowAvailable,
      className: paths.length || kind === 'refs' ? 'rufa-project-folder-add' : 'rufa-project-folder-empty',
      ...(kind === 'work' ? { 'data-rufa-project-browse': '' } : { 'data-rufa-project-reference-browse': '' }),
      onClick: event => { event.stopPropagation(); openPicker(kind); } },
      h(paths.length || kind === 'refs' ? IconPlusOutlineRegular : IconFolderCloseRegular, { size: paths.length || kind === 'refs' ? 16 : 26 }),
      h('span', null, paths.length ? '添加文件夹' : kind === 'refs' ? '添加参考文件夹' : automatic ? '将自动创建项目文件夹' : '选择项目文件夹',
        !paths.length && kind === 'work' && h('small', null, automatic ? '项目中的所有会话共用' : '从此电脑中选择，可添加多个文件夹'))));
  return h(react.Fragment, null,
    h(Menu, { open: open && !direct && !dialogOpen, anchor: null, getAnchorRect, side, portal: true,
      items, footer: [add], selectedId: selectedId ?? none, onClose,
      onSelect: id => { if (id === add.id) begin(); else { onClose(); onPick(id === none ? undefined : id); } } }),
    // Keep the same modal and form mounted behind either directory picker.
    // The picker owns its Escape/cancel; the parent is temporarily read-only.
    h(Modal, { open: dialogOpen, onClose: close, headless: true, title: '创建项目', className: 'rufa-project-modal' },
      h('form', { 'data-rufa-project-dialog': '', className: 'rufa-project-form', onSubmit: submit, 'aria-busy': busy },
        h('div', { className: 'rufa-project-heading' }, h('h2', null, '创建项目'),
          h('button', { type: 'button', className: 'rufa-project-icon', 'aria-label': '关闭', disabled: busy, onClick: close }, h(IconCloseOutlineRegular, { size: 18 }))),
        h('label', { className: 'rufa-project-name' }, h(IconFolderCloseRegular, { size: 19 }),
          h('input', { name: 'projectName', 'aria-label': '项目名称', value: title, maxLength: 100, 'data-modal-autofocus': '', autoComplete: 'off',
            disabled: busy, placeholder: '项目名称', onChange: event => setTitle(event.target.value) })),
        h('div', { className: 'rufa-project-label' }, '项目文件夹',
          h(Tooltip, { label: '智能体能够使用或参考的文件夹。第一个是保存生成结果的工作文件夹，其余用于读取和参考。项目中的所有会话共用。', side: 'bottom', portal: true, maxWidth: 310 },
            h('button', { type: 'button', className: 'rufa-project-info rufa-project-icon', 'aria-label': '项目文件夹说明', 'data-rufa-project-info': '' },
              h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, 'aria-hidden': true },
                h('circle', { cx: 12, cy: 12, r: 9 }), h('path', { d: 'M12 7v6m0 3v1' }))))),
        h('label', { className: 'rufa-project-auto' },
          h('input', { type: 'checkbox', checked: automatic, disabled: busy, 'data-rufa-project-auto': '',
            onChange: event => { setAutomatic(event.target.checked); setError(''); } }), '自动创建项目文件夹'),
        folderList(folders, 'work', automatic || busy),
        h('button', { type: 'button', className: 'rufa-project-reference-toggle', 'data-rufa-project-references-toggle': '',
          'aria-expanded': referencesOpen, disabled: busy, onClick: () => setReferencesOpen(value => !value) },
          h('span', { 'aria-hidden': true, className: 'rufa-project-chevron' }, '›'), '添加参考文件夹', h('span', null, '（可选）')),
        referencesOpen && h('div', { className: 'rufa-project-references' },
          h('p', { className: 'rufa-project-hint' }, '用于读取和参考资料，生成的文件仍保存到工作文件夹。'),
          folderList(references, 'refs', busy)),
        error && h('p', { role: 'alert', className: 'rufa-project-error' }, error),
        h('div', { className: 'rufa-project-footer' },
          h(Button, { variant: 'ghost', disabled: busy, onClick: close, 'data-rufa-project-cancel': '' }, '取消'),
          h(Button, { variant: 'primary', disabled: busy || !title.trim() || !automatic && !folders.length,
            onClick: submit, 'data-rufa-project-submit': '' }, pending ? '正在创建…' : '创建项目')))),
    renderDirectoryFlow({ open: browseOpen, busy: pending,
      onPicked: selected => {
        if (!finishPicker()) return;
        if ([...folders, ...references].some(path => pathKey(path) === pathKey(selected))) { setError('此文件夹已添加。'); return; }
        if (Math.max(0, folders.length - 1) + references.length >= 31 && (picking.current !== 'work' || folders.length > 0)) { setError('最多添加31个参考文件夹。'); return; }
        (picking.current === 'work' ? setFolders : setReferences)(values => [...values, selected]); setError('');
      },
      onCancel: finishPicker, onError: message => { if (finishPicker()) setError(message); } }));
}
