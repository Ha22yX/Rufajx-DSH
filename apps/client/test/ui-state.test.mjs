import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { AccountUiStateStore } from '../dist/ui-state.js';
import { accountRuntimePaths } from '../dist/runtime-configuration.js';
import { CompanyError } from '../dist/types.js';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rufa-ui-state-')));
  t.after(async () => { assert.equal(dirname(root), await realpath(tmpdir())); assert.ok(basename(root).startsWith('rufa-ui-state-')); await rm(root, { recursive: true, force: true }); });
  const account = async (server, id) => { const home = accountRuntimePaths(root, server, id).companyHome; await mkdir(home, { recursive: true }); return { home, store: new AccountUiStateStore(home) }; };
  return { root, account };
}
const draftKey = 'dsh.conversation.session-123', selectionKey = 'dsh.sessions.current';
const draft = JSON.stringify({ draft: { text: '重启后的草稿 @文件', references: [{ offset: 7, clipboardText: '@文件', kind: 'file', id: 'ref-1' }] }, view: 'conversation', viewRequest: null });

test('native draft and current selection survive account-store recreation while servers and users remain isolated', async t => {
  const f = await fixture(t), a = await f.account('https://company.example', 'alice'), b = await f.account('https://company.example', 'bob'), other = await f.account('https://other.example', 'alice');
  a.store.commit({ set: { [draftKey]: draft, [selectionKey]: JSON.stringify({ sessionId: 'session-123' }) } });
  const restored = new AccountUiStateStore(a.home);
  assert.equal(restored.snapshot().entries[draftKey], draft);
  assert.equal(restored.snapshot().entries[selectionKey], '{"sessionId":"session-123"}');
  assert.deepEqual(b.store.snapshot(), { exists: false, entries: {} }); assert.deepEqual(other.store.snapshot(), { exists: false, entries: {} });
  restored.commit({ remove: [draftKey] });
  assert.equal(new AccountUiStateStore(a.home).snapshot().entries[draftKey], undefined);
  const before = await readFile(join(a.home, 'browser-ui-state.json'), 'utf8');
  for (const operation of [{ set: { accessToken: '"secret"' } }, { set: { [draftKey]: 'invalid-json' } }, { remove: ['../other'] }, { set: { [draftKey]: '"' + 'x'.repeat(1024 * 1024) + '"' } }, { path: b.home }]) assert.throws(() => restored.commit(operation));
  assert.equal(await readFile(join(a.home, 'browser-ui-state.json'), 'utf8'), before);
});

test('redirected account roots and corrupt saved data are rejected without replacing the original file', async t => {
  const f = await fixture(t), a = await f.account('https://company.example', 'alice');
  const alias = join(f.root, 'alias'); await symlink(a.home, alias, 'junction');
  assert.throws(() => new AccountUiStateStore(alias), /redirected/);
  const file = join(a.home, 'browser-ui-state.json'); await writeFile(file, '{broken');
  assert.throws(() => new AccountUiStateStore(a.home)); assert.equal(await readFile(file, 'utf8'), '{broken');
});

test('real preload hydrates before application stores and mirrors only allowed localStorage mutations across origins', async t => {
  const f = await fixture(t), a = await f.account('https://company.example', 'alice');
  const preload = await readFile(new URL('../src/account-preload.cjs', import.meta.url), 'utf8');
  function boot(store, initial = {}, mainFrame = true) {
    const world = vm.createContext({});
    vm.runInContext(`class Storage { constructor(){this.data=new Map()}get length(){return this.data.size}key(i){return [...this.data.keys()][i]??null}getItem(k){return this.data.get(String(k))??null}setItem(k,v){this.data.set(String(k),String(v))}removeItem(k){this.data.delete(String(k))}clear(){this.data.clear()}};this.Storage=Storage;this.localStorage=new Storage();this.sessionStorage=new Storage();this.window=this;`, world);
    for (const [key, value] of Object.entries(initial)) world.localStorage.setItem(key, value);
    const channels = [];
    vm.runInNewContext(preload, { process: { isMainFrame: mainFrame }, require: () => ({
      contextBridge: { exposeInMainWorld(name, value) { world[name] = value; }, executeInMainWorld({ func, args }) { world.args = args; vm.runInContext(`(${func.toString()})(...args)`, world); } },
      ipcRenderer: { sendSync(channel, input) { channels.push(channel); if (channel === 'rufa:ui-state:load') return { ok: true, value: store.snapshot() }; assert.equal(channel, 'rufa:ui-state:commit'); store.commit(input); return { ok: true }; } },
    }) });
    return { world, channels };
  }
  const first = boot(a.store, { [selectionKey]: '{"sessionId":"legacy-local"}', unrelated: 'keep' });
  assert.equal(a.store.snapshot().entries[selectionKey], '{"sessionId":"legacy-local"}');
  first.world.localStorage.setItem(draftKey, draft);
  first.world.localStorage.setItem('unrelated', 'value'); first.world.sessionStorage.setItem(draftKey, 'session-only');
  assert.equal(a.store.snapshot().entries[draftKey], draft); assert.equal(a.store.snapshot().entries.unrelated, undefined);
  const second = boot(new AccountUiStateStore(a.home), { [draftKey]: '"stale-origin-value"', unrelated: 'other-origin' });
  assert.equal(second.world.localStorage.getItem(draftKey), draft);
  assert.equal(second.world.localStorage.getItem('unrelated'), 'other-origin');
  second.world.localStorage.removeItem(draftKey); assert.equal(new AccountUiStateStore(a.home).snapshot().entries[draftKey], undefined);
  second.world.localStorage.clear(); assert.deepEqual(new AccountUiStateStore(a.home).snapshot().entries, {});
  const subframe = boot(a.store, {}, false); assert.equal(subframe.channels.length, 0); assert.equal(subframe.world.rufaUiState, undefined);
});

test('actual main handlers reject other frames, origins, accounts, devices and expired authorization before reading or writing UI state', async t => {
  const f = await fixture(t), a = await f.account('https://company.example', 'alice');
  const compiled = await readFile(new URL('../dist/main.js', import.meta.url), 'utf8');
  const handlers = compiled.slice(compiled.indexOf('function id('), compiled.indexOf('async function main('));
  const frame = { url: 'http://127.0.0.1:1234/' }, contents = { mainFrame: frame, isDestroyed: () => false }, event = { senderFrame: frame, sender: contents };
  const state = { user: { id: 'alice' }, deviceId: 'device-a' };
  const context = vm.createContext({ URL, CompanyError, quitting: false, view: { webContents: contents },
    api: { state, authorizationEpoch: 3 }, viewAccount: { origin: 'http://127.0.0.1:1234', userId: 'alice', deviceId: 'device-a', epoch: 3 }, uiStateStore: a.store });
  vm.runInContext(handlers, context);
  context.accountUiState(event, 'commit', { set: { [draftKey]: draft } });
  assert.equal(context.accountUiState(event, 'load').entries[draftKey], draft);
  const reject = invalid => { for (const operation of ['load', 'commit']) assert.throws(() => context.accountUiState(invalid, operation, { remove: [draftKey] }), { code: 'LOGIN_REQUIRED' }); };
  reject({ ...event, sender: {} }); reject({ ...event, senderFrame: { url: frame.url } });
  frame.url = 'http://127.0.0.1:9999/'; reject(event); frame.url = 'http://127.0.0.1:1234/';
  state.user = { id: 'bob' }; reject(event); state.user = { id: 'alice' };
  state.deviceId = 'other'; reject(event); state.deviceId = 'device-a';
  context.api.authorizationEpoch = 4; reject(event); context.api.authorizationEpoch = 3;
  context.quitting = true; reject(event);
  assert.equal(new AccountUiStateStore(a.home).snapshot().entries[draftKey], draft);
});
