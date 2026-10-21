import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { CompanyApi } from '../dist/company-api.js';
import { CompanyError } from '../dist/types.js';
import { RememberedPasswordStore } from '../dist/remembered-login.js';
import { COMPANY_SERVER } from '../dist/company-config.js';

const compiled = await readFile(new URL('../dist/main.js', import.meta.url), 'utf8');
// Run the actual compiled command/account handlers without starting Electron or the user's workspace.
const handlers = compiled.slice(compiled.indexOf('function id('), compiled.indexOf('async function main('));
assert.ok(handlers.includes('async function changeAccountPassword('));
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const user = { id: 'account-a', username: 'alice', displayName: '合成员工', role: 'employee' };
const login = who => ({ user: who, accessToken: `synthetic-access-${who.id}`, refreshToken: `synthetic-refresh-${who.id}`, deviceId: `device-${who.id}`, expiresAt: new Date(Date.now() + 3600000).toISOString() });

async function fixture(t, responses = {}) {
  const root = await mkdtemp(join(tmpdir(), 'rufa-account-boundary-')), path = join(root, 'remembered-login.enc');
  t.after(() => rm(root, { recursive: true, force: true }));
  const key = randomBytes(32);
  const encryption = {
    isEncryptionAvailable: () => true,
    encryptString(text) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, cipher.update(text, 'utf8'), cipher.final(), cipher.getAuthTag()]); },
    decryptString(data) { const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12)); cipher.setAuthTag(data.subarray(-16)); return Buffer.concat([cipher.update(data.subarray(12, -16)), cipher.final()]).toString('utf8'); },
  };
  const passwords = new RememberedPasswordStore(path, encryption);
  await passwords.write(COMPANY_SERVER, 'alice', 'synthetic-old-password');
  const vault = { value: null, async read() { return this.value; }, async write(value) { this.value = value; }, async clear() { this.value = null; } };
  const requests = [];
  const api = new CompanyApi(vault, false, async (url, init) => {
    requests.push({ url, init });
    const route = new URL(url).pathname;
    if (responses[route]) return responses[route](init);
    if (route === '/api/v1/auth/login') { const who = JSON.parse(init.body).username; return Response.json(login(who === 'bob' ? { ...user, id: 'account-b', username: 'bob' } : user)); }
    if (route === '/api/v1/auth/change-password' || route === '/api/v1/auth/logout') return new Response(null, { status: 204 });
    if (route === '/api/v1/auth/profile') { const values = JSON.parse(init.body); return Response.json({ user: { ...user, displayName: values.displayName.trim(), jobTitle: values.jobTitle.trim() } }); }
    throw new Error('Unexpected test endpoint');
  }, COMPANY_SERVER);
  await api.login(COMPANY_SERVER, 'alice', 'synthetic-old-password');
  const frame = { url: 'http://127.0.0.1:12345/' }, contents = { mainFrame: frame, isDestroyed: () => false };
  const target = { webContents: contents }, event = { sender: contents, senderFrame: frame };
  const counters = { destroyed: 0, stopped: 0, hidden: 0, broadcasts: 0 }, timers = new Map();
  const context = vm.createContext({ api, passwords, CompanyError, companyServer: COMPANY_SERVER, randomUUID, URL,
    booting: false, quitting: false, loginRequests: 0, passwordGeneration: 0, rememberedPasswordInvalidated: false,
    accountPasswordPending: false, accountProfilePending: false, accountCompletion: null, loginNotice: '', view: target,
    viewAccount: { origin: 'http://127.0.0.1:12345', userId: user.id, deviceId: api.state.deviceId, epoch: api.authorizationEpoch },
    hostname: () => 'isolated-test', host: { stop: async () => { counters.stopped++; } },
    setTimeout(fn) { const id = randomUUID(); timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
    state: () => ({ ...api.state }), publicAccount: () => { const u = api.state.user; return u && { username: u.username, displayName: u.displayName, jobTitle: u.jobTitle, role: u.role }; },
    broadcast: () => { counters.broadcasts++; }, hideHarness: () => { counters.hidden++; },
    destroyHarnessView: () => { counters.destroyed++; context.view = null; context.viewAccount = null; },
  });
  vm.runInContext(handlers, context);
  return { context, event, target, api, passwords, vault, path, requests, counters, timers };
}

test('saved password reveal binds username and fixed server, excludes public state, and rejects logged-in/booting clients', async t => {
  const f = await fixture(t), c = f.context;
  await assert.rejects(c.command('login.revealSavedPassword', { username: 'alice' }), { code: 'PASSWORD_REVEAL_UNAVAILABLE' });
  await f.api.clearLocalLogin();
  const metadata = await c.command('login.saved'); assert.equal(metadata.password, undefined);
  await assert.rejects(c.command('login.revealSavedPassword', { username: 'bob' }), { code: 'PASSWORD_REQUIRED' });
  const value = await c.command('login.revealSavedPassword', { username: 'alice', serverUrl: 'https://untrusted.example' });
  assert.equal(value.password, 'synthetic-old-password');
  assert.equal(JSON.stringify(await c.command('state')).includes('synthetic-old-password'), false);
  c.booting = true; await assert.rejects(c.command('login.revealSavedPassword', { username: 'alice' }), { code: 'STARTUP_PENDING' });
});

test('a reveal waiting on encrypted storage is cancelled by forgetting or starting a login', async t => {
  for (const action of ['forget', 'login']) await t.test(action, async t => {
    const loginGate = defer();
    const f = await fixture(t), c = f.context; await f.api.clearLocalLogin();
    const read = f.passwords.passwordFor.bind(f.passwords), gate = defer();
    f.passwords.passwordFor = async (...args) => { const value = await read(...args); await gate.promise; return value; };
    const reveal = c.command('login.revealSavedPassword', { username: 'alice' });
    const rejected = assert.rejects(reveal, { code: 'PASSWORD_REVEAL_CANCELLED' });
    let attempt;
    if (action === 'forget') await c.command('login.forget');
    else {
      f.api.login = async () => loginGate.promise;
      attempt = c.command('login', { username: 'alice', password: 'synthetic-new-password', rememberPassword: true });
      await assert.rejects(c.command('login.revealSavedPassword', { username: 'alice' }), { code: 'PASSWORD_REVEAL_UNAVAILABLE' });
    }
    gate.resolve(); await rejected; loginGate.resolve(); await attempt;
  });
});

test('account password change clears both stores and defers view destruction until receipt', async t => {
  const f = await fixture(t), input = { currentPassword: 'synthetic-old-password', newPassword: 'synthetic-new-password' };
  const result = await f.context.changeAccountPassword(f.event, input);
  assert.equal(result.changed, true); assert.equal(result.localCleanupComplete, true);
  assert.equal(f.api.state.user, null); assert.equal(f.vault.value, null); await assert.rejects(access(f.path), { code: 'ENOENT' });
  assert.equal(input.currentPassword, ''); assert.equal(input.newPassword, '');
  assert.equal(f.counters.destroyed, 0); assert.equal(f.context.view, f.target);
  f.context.finishAccountPasswordChange('wrong-receipt'); assert.equal(f.counters.destroyed, 0);
  f.context.finishAccountPasswordChange(result.completionId); assert.equal(f.counters.destroyed, 1); assert.equal(f.counters.stopped, 1);
  assert.match(f.context.loginNotice, /使用新密码/);
  assert.equal(f.requests.filter(row => row.url.endsWith('/auth/change-password')).length, 1);
  assert.equal(f.requests.some(row => row.url.endsWith('/auth/logout')), false);
});

test('wrong current password preserves the session and saved credential; server error text stays private', async t => {
  const f = await fixture(t, { '/api/v1/auth/change-password': () => Response.json({ error: { code: 'INVALID_CURRENT_PASSWORD', message: 'synthetic-upstream-private' } }, { status: 400 }) });
  await assert.rejects(f.context.changeAccountPassword(f.event, { currentPassword: 'wrong', newPassword: 'synthetic-new-password' }), error => error.code === 'INVALID_CURRENT_PASSWORD' && error.message === '原密码不正确，请重新输入。');
  assert.equal(f.api.state.user.id, user.id); assert.ok(f.vault.value);
  assert.equal(await f.passwords.passwordFor(COMPANY_SERVER, 'alice'), 'synthetic-old-password'); assert.equal(f.counters.destroyed, 0);
});

test('account commands reject foreign frames, stale identities, duplicate changes and invalid values before mutation', async t => {
  const gate = defer(), f = await fixture(t, { '/api/v1/auth/change-password': () => gate.promise }), c = f.context;
  const input = () => ({ currentPassword: 'synthetic-old-password', newPassword: 'synthetic-new-password' });
  for (const bad of [{ ...f.event, sender: {} }, { ...f.event, senderFrame: { url: f.event.senderFrame.url } }]) {
    await assert.rejects(c.changeAccountPassword(bad, input()), { code: 'UNTRUSTED_ACCOUNT_VIEW' });
  }
  f.event.senderFrame.url = 'https://untrusted.example/'; await assert.rejects(c.changeAccountPassword(f.event, input()), { code: 'UNTRUSTED_ACCOUNT_VIEW' });
  f.event.senderFrame.url = 'http://127.0.0.1:12345/';
  await assert.rejects(c.changeAccountPassword(f.event, { ...input(), newPassword: '12345678901' }), { code: 'INVALID_PASSWORD' });
  const first = c.changeAccountPassword(f.event, input());
  await assert.rejects(c.changeAccountPassword(f.event, input()), { code: 'PASSWORD_CHANGE_PENDING' });
  await assert.rejects(c.command('logout'), { code: 'PASSWORD_CHANGE_PENDING' });
  await assert.rejects(c.command('login', {}), { code: 'PASSWORD_CHANGE_PENDING' });
  await f.api.login(COMPANY_SERVER, 'bob', 'synthetic-bob-password');
  gate.resolve(new Response(null, { status: 204 })); await assert.rejects(first, { code: 'LOGIN_CANCELLED' });
  assert.equal(f.api.state.user.username, 'bob'); assert.ok(f.vault.value); assert.equal(f.counters.destroyed, 0);
});

test('profile changes update public identity immediately, normalize legacy job title, and preserve login', async t => {
  const f = await fixture(t), c = f.context, epoch = f.api.authorizationEpoch;
  assert.equal(f.api.state.user.jobTitle, '');
  const result = await c.updateAccountProfile(f.event, { displayName: ' 新姓名 ', jobTitle: ' 工程师 ' });
  assert.equal(result.displayName, '新姓名'); assert.equal(result.jobTitle, '工程师');
  assert.equal(result.id, undefined); assert.equal(result.accessToken, undefined);
  assert.equal(f.api.state.user.displayName, '新姓名'); assert.equal(f.api.authorizationEpoch, epoch); assert.ok(f.vault.value);
  await c.updateAccountProfile(f.event, { displayName: '新姓名', jobTitle: '' }); assert.equal(f.api.state.user.jobTitle, '');
  for (const value of [{ displayName: ' ', jobTitle: '' }, { displayName: 'a'.repeat(129), jobTitle: '' }, { displayName: '姓名', jobTitle: 'b'.repeat(101) }]) {
    await assert.rejects(c.updateAccountProfile(f.event, value), { code: 'INVALID_REQUEST' });
  }
});

test('a late profile response cannot modify a new login or expose credentials', async t => {
  const gate = defer(), f = await fixture(t, { '/api/v1/auth/profile': () => gate.promise });
  const changing = f.context.updateAccountProfile(f.event, { displayName: '新姓名', jobTitle: '工程师' });
  await assert.rejects(f.context.updateAccountProfile(f.event, { displayName: '重复', jobTitle: '' }), { code: 'ACCOUNT_UPDATE_PENDING' });
  await f.api.login(COMPANY_SERVER, 'bob', 'synthetic-bob-password');
  gate.resolve(Response.json({ user: { ...user, displayName: '新姓名', jobTitle: '工程师' } }));
  await assert.rejects(changing, { code: 'LOGIN_CANCELLED' }); assert.equal(f.api.state.user.username, 'bob');
});

test('completion timeout retires a view that never acknowledges without restoring old credentials', async t => {
  const f = await fixture(t);
  await f.context.changeAccountPassword(f.event, { currentPassword: 'synthetic-old-password', newPassword: 'synthetic-new-password' });
  assert.equal(f.timers.size, 1); [...f.timers.values()][0]();
  assert.equal(f.counters.destroyed, 1); assert.equal(f.api.state.user, null);
});

test('a local cleanup failure still signs out and prevents displaying or reusing the invalidated saved password', async t => {
  const f = await fixture(t), clear = f.passwords.clear.bind(f.passwords);
  f.passwords.clear = async () => { throw new Error('synthetic-file-error'); };
  const result = await f.context.changeAccountPassword(f.event, { currentPassword: 'synthetic-old-password', newPassword: 'synthetic-new-password' });
  assert.equal(result.localCleanupComplete, false); assert.equal(f.api.state.user, null);
  assert.match(f.context.loginNotice, /清理失败/);
  f.context.finishAccountPasswordChange(result.completionId);
  assert.equal((await f.context.command('login.saved')).remembered, false);
  await assert.rejects(f.context.command('login.revealSavedPassword', { username: 'alice' }), { code: 'PASSWORD_REVEAL_UNAVAILABLE' });
  await assert.rejects(f.context.command('login', { username: 'alice', useSavedPassword: true, rememberPassword: true }), { code: 'PASSWORD_REQUIRED' });
  await clear();
});

test('restore action verifies current admin and posts without a body, while mapping expired restore errors locally', async t => {
  let mode = 'employee'; const requests = [];
  const f = await fixture(t, {
    '/api/v1/auth/me': () => Response.json({ user: { ...user, role: mode, jobTitle: '' } }),
    '/api/v1/admin/users/recycled/restore': init => { requests.push(init); return mode === 'admin' ? Response.json({ user: { ...user, status: 'active' } }) : new Response(null, { status: 500 }); },
    '/api/v1/admin/users/expired/restore': () => Response.json({ error: { code: 'RESTORE_EXPIRED', message: 'synthetic-private-server-message' } }, { status: 409 }),
  });
  await assert.rejects(f.context.command('admin.restoreUser', { id: 'recycled' }), { code: 'FORBIDDEN' }); assert.equal(requests.length, 0);
  mode = 'admin'; await f.context.command('admin.restoreUser', { id: 'recycled' });
  assert.equal(requests[0].method, 'POST'); assert.equal(requests[0].body, undefined);
  await assert.rejects(f.context.command('admin.restoreUser', { id: 'expired' }), error => error.code === 'RESTORE_EXPIRED' && error.message.includes('7 天') && !error.message.includes('synthetic-private'));
});

test('committed password change still clears old local credentials when an in-flight verify revokes the same login first', async t => {
  const gate = defer(), f = await fixture(t, {
    '/api/v1/auth/change-password': () => gate.promise,
    '/api/v1/auth/me': () => Response.json({ error: { code: 'UNAUTHORIZED' } }, { status: 403 }),
  });
  const epoch = f.api.authorizationEpoch, lifecycle = f.api.loginLifecycleEpoch;
  const changing = f.context.changeAccountPassword(f.event, { currentPassword: 'synthetic-old-password', newPassword: 'synthetic-new-password' });
  await assert.rejects(f.api.verify(), { code: 'UNAUTHORIZED' });
  assert.equal(f.api.state.user, null); assert.notEqual(f.api.authorizationEpoch, epoch); assert.equal(f.api.loginLifecycleEpoch, lifecycle);
  gate.resolve(new Response(null, { status: 204 })); const result = await changing;
  assert.equal(result.changed, true); assert.equal(result.localCleanupComplete, true);
  assert.equal(f.vault.value, null); await assert.rejects(access(f.path), { code: 'ENOENT' });
  assert.match(f.context.loginNotice, /新密码/); assert.equal(f.requests.filter(row => row.url.endsWith('/auth/change-password')).length, 1);
  f.context.finishAccountPasswordChange(result.completionId);
});

test('a committed old password change cannot erase a new login attempt even before that attempt returns', async t => {
  for (const nextUser of ['alice', 'bob']) await t.test(nextUser, async t => {
    const changeGate = defer(), loginGate = defer(); let blockLogin = false;
    const f = await fixture(t, {
      '/api/v1/auth/login': init => blockLogin ? loginGate.promise : Response.json(login(user)),
      '/api/v1/auth/change-password': () => changeGate.promise,
    });
    const changing = f.context.changeAccountPassword(f.event, { currentPassword: 'synthetic-old-password', newPassword: 'synthetic-new-password' });
    blockLogin = true; const next = f.api.login(COMPANY_SERVER, nextUser, 'synthetic-next-password');
    changeGate.resolve(new Response(null, { status: 204 })); await assert.rejects(changing, { code: 'LOGIN_CANCELLED' });
    assert.equal(f.context.rememberedPasswordInvalidated, false); assert.equal(f.counters.destroyed, 0);
    assert.equal(await f.passwords.passwordFor(COMPANY_SERVER, 'alice'), 'synthetic-old-password');
    loginGate.resolve(Response.json(login({ ...user, id: nextUser === 'bob' ? 'account-b' : user.id, username: nextUser })));
    await next; assert.equal(f.api.state.user.username, nextUser); assert.ok(f.vault.value);
  });
});
