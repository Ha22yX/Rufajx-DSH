import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const brand = await readFile(new URL('../src/runtime/brand/client.js', import.meta.url), 'utf8');
const startupScript = await readFile(new URL('../src/runtime/brand/startup.js', import.meta.url), 'utf8');
function store(value) {
  const listeners = new Set();
  return { listeners, getSnapshot: () => value, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }, set(next) { value = next; for (const fn of [...listeners]) fn(); } };
}
function boot({ blank = true } = {}) {
  const calls = [], cleanup = [];
  const workspaces = store({ phase: 'pending', state: 'loading', error: null, items: [] });
  const sessions = store({ phase: 'pending', byId: { s: { cwd: '/work' } } });
  const session = store({ openState: 'loading', removed: false, blank, subagent: null });
  const current = store({ key: undefined, hooks: {} });
  const scope = { workspaces: { list: workspaces }, sessions: { list: sessions }, uiSession: { adapter: { current } }, effect(fn) { cleanup.push(fn()); } };
  let plugin, rendered = false, observe;
  vm.runInNewContext(brand, {
    document: { getElementById: () => ({}), querySelector: () => rendered ? {} : null },
    MutationObserver: class { constructor(fn) { observe = fn; } observe() {} disconnect() {} },
    window: { __RUFA_STARTUP__: { status() {}, ready() { calls.push('ready'); }, stall() { calls.push('stall'); } },
      __ModuleLoader__: { load(definition) { plugin = definition.factory(() => ({})); } } },
  });
  plugin.apply({ inject(names, fn) { if (names.includes('workspaces')) fn(scope); }, effect() {}, slots: { inject() {} } });
  return { calls, workspaces, sessions, session, current,
    render() { rendered = true; observe(); }, dispose() { cleanup.forEach(fn => fn?.()); } };
}
test('startup waits for directory, selection, session history, membership echo and renderer; then stops watching', () => {
  const b = boot(); b.render();
  b.workspaces.set({ phase: 'ready', state: 'idle', error: null, items: [{ path: '/work', sessionIds: [] }] });
  b.sessions.set({ phase: 'ready', byId: { s: { cwd: '/work' } } });
  b.current.set({ key: 's', hooks: { session: b.session } });
  assert.deepEqual(b.calls, []);
  b.session.set({ openState: 'open', removed: false, blank: true, subagent: null });
  assert.deepEqual(b.calls, []);
  b.workspaces.set({ phase: 'ready', state: 'idle', error: null, items: [{ path: '/work', sessionIds: ['s'] }] });
  assert.deepEqual(b.calls, ['ready']);
  for (const source of [b.workspaces, b.sessions, b.session, b.current]) assert.equal(source.listeners.size, 0);
  b.dispose();
});
test('startup allows restored ungrouped chat, but keeps a failed history behind recovery controls', () => {
  const b = boot({ blank: false });
  b.workspaces.set({ phase: 'ready', state: 'idle', error: null, items: [] });
  b.sessions.set({ phase: 'ready', byId: { s: { cwd: '/legacy' } } });
  b.current.set({ key: 's', hooks: { session: b.session } });
  b.session.set({ openState: 'error', removed: false, blank: false, subagent: null });
  assert.deepEqual(b.calls, ['stall']);
  b.session.set({ openState: 'open', removed: false, blank: false, subagent: null });
  assert.deepEqual(b.calls, ['stall']);
  b.render(); assert.deepEqual(b.calls, ['stall', 'ready']); b.dispose();
});
test('startup settles even when a hidden WebContents suspends animation frames, with a slow-load escape', () => {
  const timers = new Map(), nodes = new Map(); let sequence = 0;
  const node = () => ({ dataset: {}, attrs: {}, removeAttribute(name) { delete this.attrs[name]; }, setAttribute(name, value) { this.attrs[name] = value; }, addEventListener() {}, remove() { this.removed = true; } });
  for (const id of ['rufa-startup', 'rufa-startup-actions', 'rufa-startup-status']) nodes.set(id, node());
  const html = node(), window = { addEventListener() {} };
  vm.runInNewContext(startupScript, { document: { documentElement: html, getElementById: id => nodes.get(id), addEventListener() {} }, window,
    requestAnimationFrame: () => 1, cancelAnimationFrame() {}, setTimeout(fn, ms) { timers.set(++sequence, { fn, ms }); return sequence; }, clearTimeout(id) { timers.delete(id); } });
  [...timers.values()].find(timer => timer.ms === 20000).fn();
  assert.equal(html.dataset.rufaStartup, 'stalled');
  assert.equal(nodes.get('rufa-startup').attrs['aria-busy'], 'false');
  window.__RUFA_STARTUP__.ready();
  [...timers.values()].find(timer => timer.ms === 120).fn();
  assert.equal(html.dataset.rufaStartup, 'ready');
  assert.equal(nodes.get('rufa-startup').inert, true);
});
