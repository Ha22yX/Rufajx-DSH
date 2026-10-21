import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { readdirSync, unlinkSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { SessionCache } from '../src/runtime/session-cache.mjs';
import { initializationOnly, emptyConversationState, emptyInputState } from '../src/runtime/empty-session-policy.mjs';
import { attachUnusedSessions } from '../src/runtime/unused-sessions.mjs';
import { installUnusedSessionUi } from '../src/runtime/unused-session-ui.mjs';
import { CompanyError } from '../dist/types.js';

const policy = { emptyConversationState, emptyInputState };
const empty = () => ({ draft: '', phase: 'plain', attachmentIds: [], occurrences: [], queue: [] });
const stored = text => JSON.stringify({ draft: { text, references: [] }, view: null, viewRequest: null });
const pause = () => new Promise(resolve => setImmediate(resolve));

test('empty policy accepts only initialization and empty semantic drafts, including whitespace', () => {
  const record = { id: 'one', ready: true, inheritedEventCount: 0, header: { id: 'one', version: 4, createdAt: 1, isSeeded: false } };
  const events = [{ type: 'permission/preset', seq: 0, time: 2, data: { preset: 'auto' } }];
  assert.equal(initializationOnly(record, events), true);
  for (const type of ['user/message', 'tool/result', 'goal/set', 'command/run', 'agent/inbox/spliced', 'unknown']) {
    assert.equal(initializationOnly(record, [{ ...events[0], type }]), false);
  }
  assert.equal(initializationOnly({ ...record, inheritedEventCount: 1 }, events), false);
  assert.equal(initializationOnly({ ...record, header: { ...record.header, parentSession: 'parent' } }, events), false);
  assert.equal(initializationOnly(null, []), false);
  for (const value of [null, undefined, stored(''), stored('   '), JSON.stringify({ draft: '' })]) assert.equal(emptyConversationState(value), true);
  for (const value of ['bad', '{}', stored('text'), JSON.stringify({ draft: '', attachmentIds: ['file'] }),
    JSON.stringify({ draft: { text: '', references: [{}] } }), JSON.stringify({ draft: { text: '', references: [], command: { token: '/goal' } } })]) assert.equal(emptyConversationState(value), false);
  assert.equal(emptyInputState(empty()), true);
  for (const patch of [{ draft: 'draft' }, { attachmentIds: ['file'] }, { occurrences: [{}] }, { queue: [{}] }, { phase: 'submitting' }, { claim: {} }]) assert.equal(emptyInputState({ ...empty(), ...patch }), false);
});

async function runtimeFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'rufa-unused-'));
  const cache = new SessionCache(root), sessions = new Map(), live = new Map(), callbacks = new Map(), emitted = [], warnings = [];
  t.after(async () => { cache.close(); assert.equal(dirname(root), tmpdir()); assert.ok(basename(root).startsWith('rufa-unused-')); await rm(root, { recursive: true, force: true }); });
  const events = [{ type: 'permission/preset', seq: 0, time: 2, data: { preset: 'auto' } }];
  const header = { version: 4, id: 'one', createdAt: 1, isSeeded: false, cwd: root };
  cache.ensure(header); cache.append('one', events);
  const journal = join(root, 'one.json');
  await writeFile(journal, JSON.stringify({ id: 'one', header, inheritedEventCount: 0, local: true, uploadRequested: false, nextSeq: 0, events }));
  let disposed = 0, detached = 0;
  const agent = { id: 'one', status: 'idle', inbox: { nextTurn: [], nextStep: [] } }, session = { id: 'one', seq: 1 };
  const handle = { agent, async dispose() { disposed++; sessions.delete('one'); live.delete('one'); callbacks.get('agent/disposed')?.({ agent }); } };
  const agents = { get: id => live.get(id), async create() { sessions.set('one', session); live.set('one', agent); return handle; }, async resume() { return handle; } };
  const writer = { id: 'one', local: true, lease: null, uploadRequested: false, async flush() {}, async close() { backend.writers.delete('one'); } };
  const backend = { cache, knownCloud: new Set(), mutations: new Map(), discarding: new Set(), discarded: new Set(),
    writers: new Map([['one', writer]]), handles: new Set(), pendingNotifications: new Map(), syncRequestedAt: new Map(), journalPath: () => journal };
  const workspace = { sessionIds: ['one'], async detachSession() { detached++; this.sessionIds = []; } };
  const ctx = { agents, logger: { warn: message => warnings.push(message) }, sessions: { get: id => sessions.get(id) }, workspaceRegistry: { list: () => [workspace] },
    on(name, fn) { callbacks.set(name, fn); return () => callbacks.delete(name); }, emit: (...args) => emitted.push(args) };
  const dispose = attachUnusedSessions(ctx, { listState: { list: async () => cache.list().map(row => ({ sessionId: row.id })) } }, backend);
  t.after(dispose); await agents.create();
  return { backend, cache, journal, header, events, session, agent, handle, writer, emitted, warnings, workspace, counts: () => ({ disposed, detached }) };
}

test('unused local session disposal removes only its metadata and journal, then cannot be repeated destructively', async t => {
  const f = await runtimeFixture(t), directory = join(f.header.cwd, 'project-files'); await mkdir(directory); await writeFile(join(directory, 'keep.txt'), 'user file');
  let confirmations = 0;
  assert.deepEqual(await f.backend.discardUnusedSession('one', async () => { confirmations++; return true; }), { deleted: true });
  assert.equal(confirmations, 2); assert.equal(f.cache.get('one'), undefined); await assert.rejects(readFile(f.journal), { code: 'ENOENT' });
  assert.deepEqual(f.counts(), { disposed: 1, detached: 1 }); assert.equal(await readFile(join(directory, 'keep.txt'), 'utf8'), 'user file');
  assert.deepEqual(await f.backend.discardUnusedSession('one', async () => true), { deleted: true });
  assert.deepEqual(f.counts(), { disposed: 1, detached: 1 });
});

test('remote, meaningful events, in-flight submission, attachment work and unknown ownership are retained', async t => {
  for (const reason of ['remote', 'content', 'submission', 'upload', 'busy', 'unowned']) await t.test(reason, async t => {
    const f = await runtimeFixture(t);
    if (reason === 'remote') f.cache.checkpoint('one', 1);
    if (reason === 'content') f.cache.append('one', [{ seq: 1, time: 3, type: 'goal/set', data: { goal: 'keep' } }]);
    if (reason === 'submission') f.backend.mutations.set('one', 1);
    if (reason === 'upload') f.writer.uploadRequested = true;
    if (reason === 'busy') f.agent.status = 'running';
    if (reason === 'unowned') f.session.seq = 2;
    assert.deepEqual(await f.backend.discardUnusedSession('one', async () => true), { deleted: false });
    assert.ok(f.cache.get('one')); assert.ok(await readFile(f.journal)); assert.equal(f.counts().disposed, 0);
  });
});

test('a draft or navigation change during disposal vetoes the final transaction and restores the retained row', async t => {
  const f = await runtimeFixture(t); let checks = 0;
  assert.deepEqual(await f.backend.discardUnusedSession('one', async () => ++checks === 1), { deleted: false });
  assert.equal(checks, 2); assert.ok(f.cache.get('one')); assert.ok(await readFile(f.journal)); assert.deepEqual(f.workspace.sessionIds, ['one']);
  assert.ok(f.emitted.some(([name, row]) => name === 'api-session/added' && row.sessionId === 'one'));
});

test('transaction rechecks exact events and never drops content added after the initial inspection', async t => {
  const f = await runtimeFixture(t), dispose = f.handle.dispose;
  f.handle.dispose = async () => { await dispose(); f.cache.append('one', [{ seq: 1, time: 3, type: 'user/message', data: {} }]); };
  assert.deepEqual(await f.backend.discardUnusedSession('one', async () => true), { deleted: false });
  assert.equal(f.cache.read('one')[1].type, 'user/message'); assert.ok(await readFile(f.journal));
  assert.equal(f.cache.discardInitialization('one', 2), false);
});

test('a post-commit stage cleanup failure still reports deletion and always releases the mutation lock', async t => {
  const f = await runtimeFixture(t), remove = f.cache.discardInitialization.bind(f.cache);
  f.cache.discardInitialization = (...args) => {
    const result = remove(...args);
    const residue = join(f.header.cwd, readdirSync(f.header.cwd).find(name => name.startsWith('one.json.discard-')));
    unlinkSync(residue); mkdirSync(residue); writeFileSync(join(residue, 'held'), 'synthetic locked residue');
    return result;
  };
  assert.deepEqual(await f.backend.discardUnusedSession('one', async () => true), { deleted: true });
  assert.equal(f.cache.get('one'), undefined); assert.equal(f.backend.discarding.has('one'), false);
  assert.equal(f.warnings.length, 1); assert.equal(f.warnings[0].includes(f.header.cwd), false);
});

function observable(value) { const listeners = new Set(); return { getSnapshot: () => value, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); }, set(next) { value = next; for (const fn of [...listeners]) fn(); } }; }
function browserFixture() {
  const states = new Map(), bindings = new Map(), inputStates = new Map(), storedValues = new Map(), blocked = new Set();
  for (const id of ['one', 'two']) { const session = observable({ sessionId: id, blank: true, running: false, removed: false, promptAttempted: false, pendingSubmissions: [] }); states.set(id, session); const ctx = { id }; bindings.set(id, { sessionId: id, session, ctx }); inputStates.set(id, observable(empty())); storedValues.set(`dsh.conversation.${id}`, stored('')); }
  const current = observable({ key: 'one', hooks: { session: states.get('one') } }), panels = observable({ activePanelId: null }), list = observable({});
  const select = id => current.set({ key: id, hooks: { session: states.get(id) } });
  let visibility, hold, releases = [], fresh = 0;
  const calls = [];
  const scope = { uiSession: { adapter: { current } }, layout: { panelInfo: panels, beginNavigation: () => new AbortController().signal },
    uiWorkspace: { openSession: select, startSession() { fresh++; select('two'); } },
    sessions: { binding: id => bindings.get(id), retain: () => ({ release() {} }), list, handleSessionRemoved(id) { states.get(id).set({ ...states.get(id).getSnapshot(), removed: true }); } },
    conversation: { input: { for: ctx => ({ state: inputStates.get(ctx.id) }), requestDraftInitialization: binding => blocked.has(binding.sessionId) ? 'blocked' : 'preserved' } } };
  const storage = { getItem: key => storedValues.get(key) ?? null, removeItem: key => storedValues.delete(key) };
  const world = { scope, policy, storage, document: { querySelectorAll: () => [], getElementById: () => ({}), documentElement: {} },
    MutationObserver: class { observe() {} disconnect() {} } };
  world.window = world;
  world.bridge = { onWorkbenchVisibility(fn) { visibility = fn; return () => {}; }, async discardEmptySession(id) {
    calls.push(id);
    if (hold) await new Promise(resolve => releases.push(resolve));
    return { ok: true, value: { deleted: world.__RUFA_CONFIRM_EMPTY_DISCARD__(id) } };
  } };
  const dispose = vm.runInNewContext(`(${installUnusedSessionUi})(scope,bridge,policy,storage)`, world);
  return { scope, states, blocked, select, panels, inputStates, storedValues, dispose, hide: () => visibility(false), show: () => visibility(true), hold: () => { hold = true; }, release: () => releases.splice(0).forEach(fn => fn()), calls: id => id ? calls.filter(value => value === id).length : calls.length, fresh: () => fresh };
}

test('navigation lifecycle handles session/plugin/management leaves while preserving text and attachment-only drafts', async () => {
  for (const destination of ['session', 'plugin', 'management']) {
    const f = browserFixture(); f.hold();
    if (destination === 'session') f.select('two'); else if (destination === 'plugin') f.panels.set({ activePanelId: 'plugins' }); else f.hide();
    assert.equal(f.calls(), 1); f.release(); await pause();
    assert.equal(f.storedValues.has('dsh.conversation.one'), false);
    if (destination === 'plugin') f.panels.set({ activePanelId: null }); else if (destination === 'management') f.show();
    if (destination !== 'session') assert.equal(f.fresh(), 1);
    f.dispose();
  }
  for (const patch of [{ draft: 'unsent' }, { attachmentIds: ['image'] }, { phase: 'submitting' }]) {
    const f = browserFixture(); f.inputStates.get('one').set({ ...empty(), ...patch }); f.select('two'); await pause();
    assert.equal(f.calls(), 0); assert.equal(f.storedValues.has('dsh.conversation.one'), true); f.dispose();
  }
});

test('returning to the same blank during pending cleanup cancels deletion before editing can resume', async () => {
  const f = browserFixture(); f.hold(); f.select('two'); f.scope.uiWorkspace.openSession('one');
  f.release(); await pause();
  assert.equal(f.storedValues.has('dsh.conversation.one'), true);
  assert.equal(f.scope.uiSession.adapter.current.getSnapshot().key, 'one');
  f.inputStates.get('one').set({ ...empty(), draft: 'typed after returning' }); f.select('two'); await pause();
  assert.equal(f.calls('one'), 1); f.release(); await pause(); f.dispose();
});

test('native detached text/reference/image submissions stay protected even after the plain editor has been emptied', async () => {
  for (const phase of ['detached-reference', 'image-encoding', 'echo', 'attempted']) {
    const f = browserFixture();
    if (phase === 'echo') f.states.get('one').set({ ...f.states.get('one').getSnapshot(), pendingSubmissions: [{}] });
    else if (phase === 'attempted') f.states.get('one').set({ ...f.states.get('one').getSnapshot(), promptAttempted: true });
    else f.blocked.add('one');
    f.select('two'); await pause(); assert.equal(f.calls('one'), 0); assert.equal(f.storedValues.has('dsh.conversation.one'), true); f.dispose();
  }
  const f = browserFixture(); f.hold(); f.select('two'); f.blocked.add('one'); f.release(); await pause();
  assert.equal(f.storedValues.has('dsh.conversation.one'), true); f.dispose();
});

test('actual main handler rechecks persisted drafts and authorization for each runtime confirmation', async () => {
  const compiled = await readFile(new URL('../dist/main.js', import.meta.url), 'utf8');
  const handlers = compiled.slice(compiled.indexOf('function id('), compiled.indexOf('async function main('));
  const frame = { url: 'http://127.0.0.1:1234/' }, contents = { mainFrame: frame, isDestroyed: () => false, executeJavaScript: async () => true };
  const event = { sender: contents, senderFrame: frame }, entries = { 'dsh.conversation.one': stored('') };
  const store = { snapshot: () => ({ entries }), commit({ remove }) { for (const key of remove) delete entries[key]; } };
  const context = vm.createContext({ URL, CompanyError, emptyConversationState, quitting: false, view: { webContents: contents }, uiStateStore: store,
    api: { state: { user: { id: 'alice' }, deviceId: 'device-a' }, authorizationEpoch: 3 }, viewAccount: { origin: 'http://127.0.0.1:1234', userId: 'alice', deviceId: 'device-a', epoch: 3 },
    host: { async discardEmptySession(_id, confirm) { assert.equal(await confirm(), true); entries['dsh.conversation.one'] = stored('new protected draft'); return confirm(); } } });
  vm.runInContext(handlers, context);
  assert.equal((await context.discardEmptySession(event, { sessionId: 'one' })).deleted, false);
  assert.equal(JSON.parse(entries['dsh.conversation.one']).draft.text, 'new protected draft');
  await assert.rejects(context.discardEmptySession({ ...event, sender: {} }, { sessionId: 'one' }), { code: 'LOGIN_REQUIRED' });
});
