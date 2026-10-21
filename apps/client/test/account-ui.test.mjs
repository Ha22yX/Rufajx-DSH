import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const brand = await readFile(new URL('../src/runtime/brand/client.js', import.meta.url), 'utf8');
const preload = await readFile(new URL('../src/account-preload.cjs', import.meta.url), 'utf8');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const initialUser = { username: 'alice', displayName: '测试员工', jobTitle: '', role: 'employee' };
const walk = (node, predicate) => node && (predicate(node) ? node : (node.children || []).flat(Infinity).map(child => typeof child === 'object' && walk(child, predicate)).find(Boolean));

// Component handlers run with deterministic hooks and native primitive placeholders. Final layout is GUI-verified separately.
function accountSection(bridge) {
  const hooks = [], effects = [], cleanup = [], rows = []; let cursor = 0, plugin;
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState(initial) { const index = cursor++; if (!(index in hooks)) hooks[index] = initial; return [hooks[index], value => { hooks[index] = typeof value === 'function' ? value(hooks[index]) : value; }]; },
    useRef(initial) { const index = cursor++; return hooks[index] ??= { current: initial }; },
    useEffect(fn, deps) {
      const index = cursor++, before = hooks[index];
      if (!before || deps.some((value, i) => value !== before[i])) { hooks[index] = deps; effects.push(() => { cleanup[index]?.(); cleanup[index] = fn(); }); }
    },
  };
  const primitives = new Proxy({}, { get: (_, name) => String(name) });
  const context = vm.createContext({ window: { __RUFA_COMPANY_USER__: initialUser, rufaAccount: bridge,
    __ModuleLoader__: { load(definition) { plugin = definition.factory(name => name === 'react' ? react : primitives); } } } });
  vm.runInContext(brand, context);
  plugin.apply({ inject() {}, effect(fn) { const off = fn(); cleanup.push(off); }, slots: { inject(_name, fn) { fn(); }, register(options, component) { rows.push({ options, component }); } } });
  const row = rows.find(row => row.options.name === 'settings.section');
  const render = () => { cursor = 0; const tree = row.component(); for (const fn of effects.splice(0)) fn(); return tree; };
  return { row, render, unmount() { for (const fn of cleanup) fn?.(); } };
}
function passwordForm() {
  const elements = { currentPassword: { value: 'synthetic-old-only' }, newPassword: { value: 'synthetic-new-only' }, confirmPassword: { value: 'synthetic-new-only' } };
  return { elements, reset() { for (const input of Object.values(elements)) input.value = ''; } };
}

test('native navigation removes only Plugins and Better Sidebar entries and restores them on unload', { skip: !process.env.RUFA_RUNTIME_ROOT }, async () => {
  const require = createRequire(join(process.env.RUFA_RUNTIME_ROOT, 'package.json'));
  const { SlotCore } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-client-ui-slots')).href);
  const core = new SlotCore(), cleanup = [], registered = [];
  core.register({ name: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' }, 'sidebar.panellist': { kind: 'list', scope: 'root' },
    'sidebar.right.pane.tab': { kind: 'keyed', scope: 'root' }, 'main.plugins': { kind: 'single', scope: 'root' } } }, () => null);
  core.register({ name: 'settings.section', id: 'general' }, () => null);
  core.register({ name: 'settings.section', id: 'rufa-work-preferences' }, () => null);
  const removeSidebar = core.register({ name: 'settings.section', id: 'better-sidebar' }, () => null);
  const removePlugins = core.register({ name: 'sidebar.panellist', id: 'plugins' }, () => null);
  core.register({ name: 'sidebar.panellist', id: 'schedules' }, () => null);
  core.register({ name: 'sidebar.right.pane.tab', key: 'better-sidebar:file' }, () => null);
  core.register({ name: 'main.plugins' }, () => null);
  const entries = core.entries, entriesOfSlot = core.entriesOfSlot, panels = core.entries('sidebar.right.pane.tab'), inventory = core.entries('main.plugins');
  const versions = ['settings.section', 'sidebar.panellist'].map(key => core.getVersion(key));
  const observed = [];
  const watchers = ['settings.section', 'sidebar.panellist'].map(key => core.subscribe(key, () => observed.push({
    key, ids: core.entriesOfSlot(key).map(row => row.options.id), version: core.getVersion(key),
  })));
  let plugin;
  vm.runInNewContext(brand, { window: { __RUFA_COMPANY_USER__: initialUser, __ModuleLoader__: { load(definition) {
    plugin = definition.factory(name => name === 'react' ? {} : new Proxy({}, { get: (_, key) => key }));
  } } } });
  const slots = { [Symbol.for('cordis.original')]: core,
    inject(name, fn) { if (['settings.section', 'sidebar.panellist'].includes(name)) fn(); },
    register(options, component) { const dispose = core.register(options, component); registered.push(dispose); return dispose; } };
  const scope = { slots, effect(fn) { cleanup.push(fn()); } };
  plugin.apply({ ...scope, inject(names, fn) { if (names.length === 1 && names[0] === 'slots') fn(scope); } });
  try {
    const shown = core.entries('settings.section');
    assert.deepEqual(Array.from(shown, row => row.options.id).sort(), ['account', 'general', 'rufa-work-preferences']);
    assert.equal(core.entries('settings.section'), shown);
    assert.equal(core.entries('sidebar.right.pane.tab'), panels); assert.equal(core.entries('main.plugins'), inventory);
    assert.equal(core.entriesOfSlot('settings.section').some(row => row.options.id === 'better-sidebar'), false);
    assert.deepEqual(Array.from(core.entriesOfSlot('sidebar.panellist'), row => row.options.id), ['schedules']);
    await new Promise(resolve => queueMicrotask(resolve));
    for (const [index, key] of ['settings.section', 'sidebar.panellist'].entries()) {
      assert.ok(core.getVersion(key) > versions[index]);
      assert.ok(observed.some(row => row.key === key));
      assert.ok(observed.filter(row => row.key === key).every(row => !row.ids.includes(key === 'settings.section' ? 'better-sidebar' : 'plugins')));
    }
    removeSidebar();
    const removeReloaded = core.register({ name: 'settings.section', id: 'better-sidebar' }, () => null);
    removePlugins();
    const removeReloadedPlugins = core.register({ name: 'sidebar.panellist', id: 'plugins' }, () => null);
    assert.equal(core.entries('settings.section').some(row => row.options.id === 'better-sidebar'), false);
    assert.equal(core.entriesOfSlot('sidebar.panellist').some(row => row.options.id === 'plugins'), false);
    assert.equal(core.entries('sidebar.right.pane.tab'), panels); assert.equal(core.entries('main.plugins'), inventory);
    removeReloaded();
    removeReloadedPlugins();
  } finally { for (const dispose of cleanup.reverse()) dispose?.(); for (const dispose of registered.reverse()) dispose(); }
  assert.equal(core.entries, entries);
  assert.equal(core.entriesOfSlot, entriesOfSlot);
  const remove = core.register({ name: 'settings.section', id: 'better-sidebar' }, () => null);
  const removePlugin = core.register({ name: 'sidebar.panellist', id: 'plugins' }, () => null);
  assert.equal(core.entries('settings.section').some(row => row.options.id === 'better-sidebar'), true);
  assert.equal(core.entriesOfSlot('sidebar.panellist').some(row => row.options.id === 'plugins'), true);
  await new Promise(resolve => queueMicrotask(resolve));
  assert.ok(observed.some(row => row.key === 'settings.section' && row.ids.includes('better-sidebar')));
  assert.ok(observed.some(row => row.key === 'sidebar.panellist' && row.ids.includes('plugins')));
  remove(); removePlugin(); watchers.forEach(off => off());
});

test('native session header removes only the two requested menus across registration and unload', { skip: !process.env.RUFA_RUNTIME_ROOT }, async () => {
  const require = createRequire(join(process.env.RUFA_RUNTIME_ROOT, 'package.json'));
  const { SlotCore } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-client-ui-slots')).href);
  const core = new SlotCore(), registered = [];
  const header = 'conversation.session.header.utilities', corner = 'conversation.session.header.corner';
  const files = 'sidebar.right.tab.files.actions';
  core.register({ name: 'root', children: { [header]: { kind: 'list', scope: 'session' },
    [corner]: { kind: 'single', scope: 'session' }, [files]: { kind: 'list', scope: 'session' } } }, () => null);
  const openDirectory = () => 'directory', downloadMenu = () => 'download', expand = () => 'expand';
  const schedule = () => 'schedule', bottom = () => 'bottom';
  const registerNative = () => [core.register({ name: header, id: 'open-in-app', order: -10 }, openDirectory),
    core.register({ name: header, id: 'session-log-download' }, downloadMenu)];
  let removeNative = registerNative();
  core.register({ name: corner }, expand);
  core.register({ name: header, id: 'schedule-catalog', order: -5 }, schedule);
  core.register({ name: header, id: 'dsh-better-sidebar:bottom-toggle', order: 10 }, bottom);
  core.register({ name: files, id: 'open-in-app' }, openDirectory);
  let plugin;
  vm.runInNewContext(brand, { window: { __ModuleLoader__: { load(definition) {
    plugin = definition.factory(name => name === 'react' ? {} : new Proxy({}, { get: (_, key) => key }));
  } } } });
  plugin.apply({ inject() {}, effect() {}, slots: {
    inject(name, fn) { if (name === header) { const iterator = fn(); if (iterator?.[Symbol.iterator]) [...iterator]; } },
    register(options, component) { const dispose = core.register(options, component); registered.push(dispose); return dispose; },
  } });
  const assertVisible = () => {
    const rows = core.entriesOfSlot(header);
    assert.equal(rows.find(row => row.options.id === 'open-in-app').component(), null);
    assert.equal(rows.find(row => row.options.id === 'session-log-download').component(), null);
    assert.equal(rows.find(row => row.options.id === 'schedule-catalog').component, schedule);
    assert.equal(rows.find(row => row.options.id === 'dsh-better-sidebar:bottom-toggle').component, bottom);
    assert.equal(core.entriesOfSlot(corner)[0].component, expand);
    assert.equal(core.entriesOfSlot(files)[0].component, openDirectory);
  };
  try {
    assertVisible();
    removeNative.forEach(dispose => dispose()); removeNative = registerNative(); assertVisible();
  } finally { registered.reverse().forEach(dispose => dispose()); }
  assert.equal(core.entriesOfSlot(header).find(row => row.options.id === 'open-in-app').component, openDirectory);
  assert.equal(core.entriesOfSlot(header).find(row => row.options.id === 'session-log-download').component, downloadMenu);
});

test('native account section validates confirmation, clears secrets, and prevents duplicate password requests', async () => {
  const gate = deferred(), sent = [], account = accountSection({ changePassword(input) { sent.push(input); return gate.promise; } });
  assert.equal(account.row.options.id, 'account'); assert.equal(account.row.options.label(), '账号信息');
  let tree = account.render(); const form = passwordForm(); form.elements.confirmPassword.value = 'different';
  await walk(tree, node => node.props.className === 'rufa-account-password').props.onSubmit({ preventDefault() {}, currentTarget: form });
  assert.equal(sent.length, 0); assert.equal(form.elements.currentPassword.value, '');
  tree = account.render(); assert.ok(walk(tree, node => node.children?.includes('两次新密码不一致，请重新输入。')));
  const request = passwordForm(), handler = walk(tree, node => node.props.className === 'rufa-account-password').props.onSubmit;
  const pending = handler({ preventDefault() {}, currentTarget: request });
  await handler({ preventDefault() {}, currentTarget: passwordForm() }); assert.equal(sent.length, 1);
  assert.equal(request.elements.currentPassword.value, '');
  gate.resolve({ ok: false, error: { message: '原密码不正确，请重新输入。' } }); await pending;
  assert.equal(sent[0].currentPassword, ''); assert.equal(sent[0].newPassword, '');
  assert.ok(walk(account.render(), node => node.children?.includes('原密码不正确，请重新输入。'))); account.unmount();
});

test('name and optional job title save together and refresh the account section', async () => {
  const sent = [], account = accountSection({ async updateProfile(input) { sent.push({ ...input }); return { ok: true, value: { ...initialUser, ...input } }; } });
  let tree = account.render();
  walk(tree, node => node.props.id === 'rufa-display-name').props.onChange({ target: { value: '新姓名' } });
  walk(tree, node => node.props.id === 'rufa-job-title').props.onChange({ target: { value: '工程师' } });
  tree = account.render(); await walk(tree, node => node.type === 'form' && node.props.className === 'rufa-account-details').props.onSubmit({ preventDefault() {} });
  assert.deepEqual(sent, [{ displayName: '新姓名', jobTitle: '工程师' }]);
  tree = account.render(); assert.ok(walk(tree, node => node.children?.includes('新姓名')));
  walk(tree, node => node.props.id === 'rufa-job-title').props.onChange({ target: { value: '' } });
  tree = account.render(); await walk(tree, node => node.type === 'form' && node.props.className === 'rufa-account-details').props.onSubmit({ preventDefault() {} });
  assert.equal(sent.at(-1).jobTitle, ''); account.unmount();
});

test('dedicated preload exposes only named account/workbench operations and acknowledges password success after its reply', async () => {
  const gate = deferred(), events = [], listeners = new Map(); let bridge;
  vm.runInNewContext(preload, { process: { isMainFrame: true }, require: () => ({
    contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'rufaAccount'); bridge = value; } },
    ipcRenderer: {
      invoke(channel, input) { events.push({ channel, input }); return channel === 'rufa:account-change-password' ? gate.promise : Promise.resolve({ ok: true }); },
      send(channel, id) { events.push({ channel, id }); }, on(channel, listener) { listeners.set(channel, listener); }, removeListener(channel) { listeners.delete(channel); },
    },
  }) });
  assert.deepEqual(Object.keys(bridge).sort(), ['changePassword', 'discardEmptySession', 'fileVersions', 'onPreferencesChanged',
    'onProfileChanged', 'onWorkbenchVisibility', 'preferences', 'profile', 'updateProfile']);
  const pending = bridge.changePassword({ currentPassword: 'synthetic-old', newPassword: 'synthetic-new', action: 'login.revealSavedPassword', serverUrl: 'https://outside.example' });
  assert.equal(events.length, 1); assert.deepEqual(Object.keys(events[0].input).sort(), ['currentPassword', 'newPassword']);
  gate.resolve({ ok: true, value: { changed: true }, completionId: 'receipt-test' }); const result = await pending;
  assert.equal(result.completionId, undefined); assert.equal(events[1].channel, 'rufa:account-change-complete'); assert.equal(events[0].input.currentPassword, '');
  await bridge.updateProfile({ displayName: '姓名', jobTitle: '', role: 'admin', userId: 'other' });
  assert.deepEqual(Object.keys(events[2].input).sort(), ['displayName', 'jobTitle']);
  const off = bridge.onProfileChanged(() => {}); assert.equal(listeners.size, 1); off(); assert.equal(listeners.size, 0);
  let exposed = false;
  vm.runInNewContext(preload, { process: { isMainFrame: false }, require: () => ({ contextBridge: { exposeInMainWorld() { exposed = true; } }, ipcRenderer: {} }) });
  assert.equal(exposed, false);
});
