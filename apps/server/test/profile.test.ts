import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { buildApp } from '../src/app.js';
import { configFromEnv } from '../src/config.js';
import { hashPassword, tokenHash } from '../src/security.js';
import { SqliteStore } from '../src/sqlite-store.js';
import type { ProfileChange, Store } from '../src/store.js';
import { AppError, type Role } from '../src/types.js';
import { MemoryStore } from './memory-store.js';

const password = 'profile-test-password-2026';
const passwordHash = await hashPassword(password);
const url = '/api/v1/auth/profile';
type Credentials = { accessToken: string; refreshToken: string; deviceId: string; user: { id: string; jobTitle: string } };
const headers = (value: Credentials) => ({ authorization: `Bearer ${value.accessToken}` });
async function fixture(t: TestContext, backend: 'memory' | 'sqlite', role: Role = 'employee') {
  const stores: Store[] = [];
  let store: MemoryStore | SqliteStore;
  if (backend === 'sqlite') {
    const directory = await mkdtemp(join(tmpdir(), 'rufa-profile-test-'));
    store = new SqliteStore(join(directory, 'company.sqlite'));
    t.after(async () => {
      for (const opened of stores) await opened.close();
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('rufa-profile-test-'));
      await rm(directory, { recursive: true, force: true });
    });
  } else store = new MemoryStore();
  stores.push(store);
  const user = await store.createUser({ username: 'self', displayName: '原姓名', role, passwordHash });
  const other = await store.createUser({ username: 'other', displayName: '他人姓名', role: 'employee', passwordHash });
  await store.createUser({ username: 'manager', displayName: '管理姓名', role: 'admin', passwordHash });
  const app = buildApp(store, configFromEnv({})); t.after(() => app.close());
  const login = async (username = 'self') => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password } });
    assert.equal(response.statusCode, 200, response.body); return response.json<Credentials>();
  };
  const first = await login(), second = await login(), manager = await login('manager'), otherLogin = await login('other');
  const change = (payload: Record<string, unknown>, credentials = first) => app.inject({ method: 'PATCH', url, headers: headers(credentials), payload });
  const audits = () => store instanceof MemoryStore ? store.audits : store.db.prepare('SELECT * FROM rufa_audit').all();
  return { store, stores, app, user, other, first, second, manager, otherLogin, login, change, audits };
}

for (const backend of ['memory', 'sqlite'] as const) {
  for (const role of ['employee', 'admin'] as const) test(`${backend}: ${role} profile edits propagate through all user outputs without revoking logins`, async t => {
    const f = await fixture(t, backend, role);
    assert.equal(f.first.user.jobTitle, ''); assert.equal(f.other.jobTitle, '');
    const response = await f.change({ displayName: '  资料更新甲  ', jobTitle: '  机械设计负责人  ' });
    const expected = { id: f.user.id, username: 'self', displayName: '资料更新甲', jobTitle: '机械设计负责人', role };
    assert.equal(response.statusCode, 200, response.body); assert.deepEqual(response.json(), { user: expected });
    assert.ok(!response.body.includes('passwordHash'));
    for (const credentials of [f.first, f.second]) {
      const me = await f.app.inject({ url: '/api/v1/auth/me', headers: headers(credentials) });
      assert.equal(me.statusCode, 200); assert.deepEqual(me.json().user, expected);
    }
    const refresh = await f.app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: f.second.refreshToken } });
    assert.equal(refresh.statusCode, 200); assert.equal(refresh.json().deviceId, f.second.deviceId); assert.deepEqual(refresh.json().user, expected);
    assert.deepEqual((await f.login()).user, expected);
    const list = await f.app.inject({ url: '/api/v1/admin/users', headers: headers(f.manager) });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().users.find((row: { id: string }) => row.id === f.user.id).jobTitle, expected.jobTitle);
    assert.ok(list.json().users.every((row: { jobTitle: unknown }) => typeof row.jobTitle === 'string'));
    const created = await f.app.inject({ method: 'POST', url: '/api/v1/admin/users', headers: headers(f.manager), payload: { username: 'new-person', displayName: '新账号', role: 'employee', password } });
    assert.equal(created.statusCode, 201); assert.equal(created.json().user.jobTitle, '');
    assert.equal((await f.store.findUser('self'))!.passwordHash, passwordHash);
    assert.deepEqual(await f.store.findUser('other'), f.other);
    assert.equal((await f.app.inject({ url: '/api/v1/auth/me', headers: headers(f.otherLogin) })).statusCode, 200);
    const auditText = JSON.stringify(f.audits());
    for (const secret of [expected.displayName, expected.jobTitle, password, passwordHash, f.first.accessToken, f.first.refreshToken]) assert.ok(!auditText.includes(secret));
    assert.equal(f.audits().filter(row => row.action === 'auth.profile.update').length, 1);
    const cleared = await f.change({ displayName: '名'.repeat(128), jobTitle: '' });
    assert.equal(cleared.statusCode, 200); assert.equal(cleared.json().user.jobTitle, '');
    const boundary = await f.change({ displayName: '本人', jobTitle: '职'.repeat(100) });
    assert.equal(boundary.statusCode, 200); assert.equal(boundary.json().user.jobTitle.length, 100);
  });

  test(`${backend}: profile rejects missing, oversized and foreign identity fields without mutations`, async t => {
    const f = await fixture(t, backend);
    for (const payload of [
      {}, { displayName: '姓名' }, { jobTitle: '职位' },
      { displayName: '', jobTitle: '' }, { displayName: '   ', jobTitle: '' },
      { displayName: 12, jobTitle: '' }, { displayName: '姓名', jobTitle: null },
      { displayName: '名'.repeat(129), jobTitle: '' }, { displayName: '姓名', jobTitle: '职'.repeat(101) },
      ...['id', 'userId', 'username', 'role', 'status'].map(key => ({ displayName: '恶意更名', jobTitle: '', [key]: f.other.id })),
    ]) {
      const response = await f.change(payload);
      assert.equal(response.statusCode, 400, response.body); assert.equal(response.json().error.code, 'INVALID_REQUEST');
    }
    assert.equal((await f.app.inject({ method: 'PATCH', url, payload: { displayName: '无登录', jobTitle: '' } })).statusCode, 401);
    assert.deepEqual(await f.store.findUser('self'), f.user);
    assert.deepEqual(await f.store.findUser('other'), f.other);
    assert.equal(f.audits().filter(row => row.action === 'auth.profile.update').length, 0);
  });

  test(`${backend}: profile commit rechecks login after request authentication`, async t => {
    const f = await fixture(t, backend);
    const auth = (await f.store.resolveAccess(tokenHash(f.first.accessToken), new Date().toISOString()))!;
    const change: ProfileChange = { userId: f.user.id, loginId: auth.login.id, accessHash: auth.login.accessHash,
      displayName: '不应写入', jobTitle: '不应保存', now: new Date().toISOString(),
      audit: { id: randomUUID(), actorId: f.user.id, action: 'auth.profile.update', createdAt: new Date().toISOString() } };
    const unauthorized = (error: unknown) => error instanceof AppError && error.code === 'UNAUTHORIZED';
    await assert.rejects(f.store.updateProfile({ ...change, userId: f.other.id }), unauthorized);
    await assert.rejects(f.store.updateProfile({ ...change, accessHash: tokenHash('stale-token') }), unauthorized);
    await assert.rejects(f.store.updateProfile({ ...change, now: auth.login.accessExpiresAt }), unauthorized);
    const commit = f.store.updateProfile.bind(f.store);
    // Deterministically revoke after the HTTP route resolved its auth snapshot.
    f.store.updateProfile = async value => { await f.store.revokeLogin(value.loginId); return commit(value); };
    assert.equal((await f.change({ displayName: change.displayName, jobTitle: change.jobTitle })).statusCode, 401);
    // A concurrently disabled user cannot be reactivated by a stale profile write.
    f.store.updateProfile = async value => { await f.store.updateUser(value.userId, { status: 'disabled' }); return commit(value); };
    assert.equal((await f.change({ displayName: change.displayName, jobTitle: change.jobTitle }, f.second)).statusCode, 401);
    const saved = (await f.store.findUser('self'))!;
    assert.equal(saved.displayName, f.user.displayName); assert.equal(saved.jobTitle, ''); assert.equal(saved.status, 'disabled');
    assert.equal(f.audits().filter(row => row.action === 'auth.profile.update').length, 0);
  });
}

test('SQLite profile audit failure rolls back fields and preserves login; persisted profile survives restart', async t => {
  const f = await fixture(t, 'sqlite'); const store = f.store as SqliteStore;
  store.db.exec("CREATE TRIGGER reject_profile_audit BEFORE INSERT ON rufa_audit WHEN NEW.action='auth.profile.update' BEGIN SELECT RAISE(ABORT,'test audit failure'); END");
  assert.equal((await f.change({ displayName: '回滚姓名', jobTitle: '回滚职位' })).statusCode, 500);
  assert.deepEqual(await store.findUser('self'), f.user);
  assert.equal((await f.app.inject({ url: '/api/v1/auth/me', headers: headers(f.first) })).statusCode, 200);
  store.db.exec('DROP TRIGGER reject_profile_audit');
  assert.equal((await f.change({ displayName: '持久姓名', jobTitle: '持久职位' })).statusCode, 200);
  await f.app.close(); await store.close();
  const reopened = new SqliteStore(store.path); f.stores.push(reopened);
  const app = buildApp(reopened, configFromEnv({})); t.after(() => app.close());
  const me = await app.inject({ url: '/api/v1/auth/me', headers: headers(f.first) });
  assert.equal(me.statusCode, 200); assert.equal(me.json().user.displayName, '持久姓名'); assert.equal(me.json().user.jobTitle, '持久职位');
  assert.equal(reopened.db.prepare("SELECT count(*) AS n FROM rufa_audit WHERE action='auth.profile.update'").get()!.n, 1);
});
