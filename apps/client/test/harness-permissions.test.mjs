import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const compiled = await readFile(new URL('../dist/main.js', import.meta.url), 'utf8');
const start = compiled.indexOf('function installHarnessPermissions(');
const end = compiled.indexOf('async function openHarness(', start);
assert.ok(start >= 0 && end > start);
const source = compiled.slice(start, end);
const origin = 'http://127.0.0.1:12345';
function fixture() {
  let check, request, prompts = [], answer = async () => ({ response: 1 });
  const contents = { getURL: () => origin + '/', isDestroyed: () => false, session: {
    setPermissionCheckHandler: fn => { check = fn; }, setPermissionRequestHandler: fn => { request = fn; },
  } };
  const target = { webContents: contents }, account = { origin, userId: 'synthetic-user', deviceId: 'synthetic-device', epoch: 1 };
  const api = { state: { user: { id: account.userId }, deviceId: account.deviceId }, authorizationEpoch: 1 };
  const context = vm.createContext({ URL, view: target, viewAccount: account, api, quitting: false, win: {},
    dialog: { async showMessageBox(_window, options) { prompts.push(options); return answer(); } } });
  vm.runInContext(source, context); context.installHarnessPermissions(target, account);
  const details = { isMainFrame: true, requestingUrl: origin + '/conversation' };
  return { context, target, contents, account, api, details, prompts, answer: fn => { answer = fn; },
    check: (permission = 'clipboard-sanitized-write', sender = contents, data = details, requested = origin) => check(sender, permission, requested, data),
    request: async (permission = 'clipboard-sanitized-write', sender = contents, data = details) => {
      let result; await request(sender, permission, value => { assert.equal(result, undefined); result = value; }, data); return result;
    } };
}

test('actual compiled main allows clipboard writes and fullscreen for the current authenticated main frame', async () => {
  const f = fixture(); assert.equal(f.check(), true); assert.equal(await f.request(), true); assert.equal(f.prompts.length, 0);
  assert.equal(f.check('fullscreen'), true); assert.equal(await f.request('fullscreen'), true); assert.equal(f.prompts.length, 0);
  for (const permission of ['clipboard-read', 'media', 'geolocation', 'unknown']) assert.equal(f.check(permission), false);
  assert.equal(await f.request('geolocation'), false); assert.equal(f.prompts.length, 0);
});

test('clipboard write rejects subframes, foreign origins, stale accounts and destroyed views', async () => {
  for (const change of [
    f => { f.details.isMainFrame = false; }, f => { f.details.requestingUrl = 'https://foreign.invalid/'; },
    f => { f.details.requestingUrl = 'not-a-url'; }, f => { delete f.details.requestingUrl; },
    f => { f.contents.getURL = () => 'https://foreign.invalid/'; }, f => { f.contents.isDestroyed = () => true; },
    f => { f.context.view = null; }, f => { f.context.viewAccount = { ...f.account }; },
    f => { f.api.state.user = null; }, f => { f.api.state.user.id = 'other'; },
    f => { f.api.state.deviceId = 'other-device'; }, f => { f.api.authorizationEpoch++; }, f => { f.context.quitting = true; },
  ]) {
    const f = fixture(); change(f); assert.equal(f.check(), false); assert.equal(await f.request(), false); assert.equal(f.prompts.length, 0);
    assert.equal(f.check('fullscreen'), false); assert.equal(await f.request('fullscreen'), false);
  }
  const f = fixture(); assert.equal(f.check(undefined, null), false); assert.equal(await f.request(undefined, { ...f.contents }), false);
  assert.equal(f.check(undefined, undefined, undefined, 'https://foreign.invalid'), false);
});

test('clipboard reads and media still prompt, honour denial, and recheck account changes after approval', async () => {
  for (const permission of ['clipboard-read', 'media']) {
    const f = fixture(); assert.equal(await f.request(permission), true); assert.equal(f.prompts.length, 1);
    f.answer(async () => ({ response: 0 })); assert.equal(await f.request(permission), false);
    f.answer(async () => { f.api.authorizationEpoch++; return { response: 1 }; });
    assert.equal(await f.request(permission), false);
  }
  const f = fixture(); f.answer(async () => { throw new Error('synthetic dialog closed'); });
  assert.equal(await f.request('clipboard-read'), false);
});
