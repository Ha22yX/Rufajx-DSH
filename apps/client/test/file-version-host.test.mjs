import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { CompanyError } from '../dist/types.js';
const compiled = await readFile(new URL('../dist/harness-host.js', import.meta.url), 'utf8');
const methods = compiled.slice(compiled.indexOf('cancelFileVersions()'), compiled.indexOf('async discardEmptySession'));
assert.ok(methods.includes('rufa:file-versions-check'));
const settle = () => new Promise(done => setImmediate(done));
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture() {
  const child = new EventEmitter(); child.connected = true; child.sent = []; child.send = (value, callback) => { child.sent.push(value); callback?.(); };
  const timers = new Map(), api = new EventEmitter(); api.verify = async () => {};
  // Actual compiled parent protocol methods; only lifecycle/test transport are supplied.
  const Host = vm.runInNewContext(`(class { #child; #state = { status: 'running' }; #versionRequests = new Set();
    constructor(child,api) { this.#child=child; this.api=api; } replace(child) { this.#child=child; }
    ${methods} })`, { CompanyError, randomUUID, setTimeout(fn) { const id = randomUUID(); timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); } });
  return { child, api, timers, host: new Host(child, api) };
}

test('parent publication check rejects obsolete frame, epoch or child before sending allowed', async () => {
  for (const change of ['frame', 'epoch', 'child']) {
    const f = fixture(), gate = defer(); let valid = true;
    f.api.verify = () => gate.promise;
    const result = f.host.fileVersions('restore', { ticketId: 'opaque' }, () => valid);
    const request = f.child.sent[0];
    f.child.emit('message', { type: 'rufa:file-versions-check', requestId: request.requestId, checkId: 'publish-check' }); await settle();
    if (change === 'child') f.host.replace(null); else valid = false;
    const rejected = assert.rejects(result, { code: 'LOGIN_CHANGED' });
    if (change === 'epoch') f.api.emit('change');
    gate.resolve(); await rejected; await settle();
    assert.equal(f.child.sent.find(row => row.type === 'rufa:file-versions-confirm')?.allowed, false);
    assert.ok(f.child.sent.some(row => row.type === 'rufa:file-versions-cancel'));
    assert.equal(f.child.listenerCount('message'), 0);
  }
});

test('parent timeout and explicit shutdown cancellation revoke pending requests and reject late replies', async () => {
  for (const reason of ['timeout', 'stop']) {
    const f = fixture(), result = f.host.fileVersions('restore', {}, () => true), request = f.child.sent[0];
    const rejected = assert.rejects(result, { code: reason === 'timeout' ? 'FILE_VERSIONS_TIMEOUT' : 'LOGIN_CHANGED' });
    if (reason === 'timeout') [...f.timers.values()][0](); else f.host.cancelFileVersions();
    await rejected;
    assert.ok(f.child.sent.some(row => row.type === 'rufa:file-versions-cancel' && row.requestId === request.requestId));
    f.child.emit('message', { type: 'rufa:file-versions-result', requestId: request.requestId, ok: true, value: 'late' });
    assert.equal(f.api.listenerCount('change'), 0);
  }
});

test('main IPC binds view and login identity, then immediately cancels on navigation or destruction', async () => {
  const main = await readFile(new URL('../dist/main.js', import.meta.url), 'utf8');
  const handler = main.slice(main.indexOf('async function fileVersions('), main.indexOf('async function updateAccountProfile('));
  const contents = new EventEmitter(), target = { webContents: contents }, gate = defer(); let cancelled = 0;
  const api = { authorizationEpoch: 1, state: { user: { id: 'a' }, deviceId: 'device-a' }, async verify() {} };
  const context = vm.createContext({ requireAccount() {}, object: x => x, CompanyError, api, view: target,
    host: { fileVersions: () => gate.promise, cancelFileVersions() { cancelled++; } } });
  vm.runInContext(handler, context);
  const pending = context.fileVersions({}, { action: 'restore' }); await settle();
  contents.emit('did-start-navigation'); contents.emit('destroyed'); assert.equal(cancelled, 2);
  context.view = null; gate.resolve({ restored: true }); await assert.rejects(pending, { code: 'LOGIN_CHANGED' });
  assert.equal(contents.listenerCount('destroyed'), 0);
});
