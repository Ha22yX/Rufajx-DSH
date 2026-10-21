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
import type { PasswordChange, Store } from '../src/store.js';
import { AppError, type Role } from '../src/types.js';
import { MemoryStore } from './memory-store.js';

const oldPassword = 'self-change-old-password-2026';
const newPassword = 'self-change-new-password-2026';
const oldHash = await hashPassword(oldPassword);
const newHash = await hashPassword(newPassword);
const path = '/api/v1/auth/change-password';
type Credentials = { accessToken: string; refreshToken: string; deviceId: string };
const headers = (credentials: Credentials) => ({ authorization: `Bearer ${credentials.accessToken}` });

async function fixture(t: TestContext, backend: 'memory' | 'sqlite', role: Role = 'employee') {
  const stores: Store[] = [];
  let store: MemoryStore | SqliteStore;
  if (backend === 'sqlite') {
    const directory = await mkdtemp(join(tmpdir(), 'rufa-change-password-'));
    store = new SqliteStore(join(directory, 'company.sqlite'));
    t.after(async () => {
      for (const opened of stores) await opened.close();
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('rufa-change-password-'));
      await rm(directory, { recursive: true, force: true });
    });
  } else store = new MemoryStore();
  stores.push(store);
  const user = await store.createUser({ username: 'self', displayName: '本人', role, passwordHash: oldHash });
  const other = await store.createUser({ username: 'other', displayName: '其他员工', role: 'employee', passwordHash: oldHash });
  const app = buildApp(store, configFromEnv({}));
  t.after(() => app.close());
  const login = (username = 'self', password = oldPassword) => app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password } });
  const first = (await login()).json<Credentials>(), second = (await login()).json<Credentials>();
  const otherLogin = (await login('other')).json<Credentials>();
  const change = (payload: unknown, credentials = first) => app.inject({ method: 'POST', url: path, headers: headers(credentials), payload: payload as Record<string, unknown> });
  const audits = () => store instanceof MemoryStore ? store.audits : store.db.prepare('SELECT * FROM rufa_audit').all();
  return { store, stores, app, user, other, first, second, otherLogin, login, change, audits };
}

for (const backend of ['memory', 'sqlite'] as const) {
  for (const role of ['employee', 'admin'] as const) test(`${backend}: ${role} self password change validates ownership and revokes every own login`, async t => {
    const f = await fixture(t, backend, role);
    assert.notEqual(f.first.deviceId, f.second.deviceId);
    const session = await f.store.createSession(f.user.id, { title: '改密保留会话' });
    const wrong = await f.change({ currentPassword: 'incorrect-password', newPassword });
    assert.equal(wrong.statusCode, 400); assert.equal(wrong.json().error.code, 'INVALID_CURRENT_PASSWORD');
    assert.equal((await f.store.findUser('self'))!.passwordHash, oldHash);
    assert.equal((await f.app.inject({ url: '/api/v1/auth/me', headers: headers(f.first) })).statusCode, 200);
    for (const payload of [
      { currentPassword: oldPassword, newPassword, userId: f.other.id },
      { currentPassword: oldPassword, newPassword, role: 'admin' },
      { currentPassword: oldPassword, newPassword, id: f.other.id },
      { currentPassword: oldPassword }, { newPassword },
      { currentPassword: 123, newPassword },
      { currentPassword: oldPassword, newPassword: 'short' },
      { currentPassword: oldPassword, newPassword: 'x'.repeat(129) },
    ]) assert.equal((await f.change(payload)).statusCode, 400);
    assert.equal((await f.app.inject({ method: 'POST', url: path, payload: { currentPassword: oldPassword, newPassword } })).statusCode, 401);
    assert.equal((await f.store.findUser('self'))!.passwordHash, oldHash);
    const success = await f.change({ currentPassword: oldPassword, newPassword });
    assert.equal(success.statusCode, 204, success.body); assert.equal(success.body, '');
    for (const credentials of [f.first, f.second]) {
      assert.equal((await f.app.inject({ url: '/api/v1/auth/me', headers: headers(credentials) })).statusCode, 401);
      assert.equal((await f.app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: credentials.refreshToken } })).statusCode, 401);
    }
    assert.equal((await f.change({ currentPassword: newPassword, newPassword: oldPassword })).statusCode, 401);
    assert.equal((await f.login()).statusCode, 401);
    const relogin = await f.login('self', newPassword);
    assert.equal(relogin.statusCode, 200); assert.equal(relogin.json().user.role, role);
    assert.equal((await f.app.inject({ url: '/api/v1/auth/me', headers: headers(f.otherLogin) })).statusCode, 200);
    assert.equal((await f.login('other')).statusCode, 200);
    assert.equal((await f.store.findUser('other'))!.passwordHash, oldHash);
    assert.equal((await f.store.getSession(session.id))!.ownerId, f.user.id);
    const audits = f.audits();
    assert.equal(audits.filter(row => row.action === 'auth.password.change').length, 1);
    for (const secret of [oldPassword, newPassword, oldHash, (await f.store.findUser('self'))!.passwordHash, f.first.accessToken, f.first.refreshToken]) assert.ok(!JSON.stringify(audits).includes(secret));
  });

  test(`${backend}: concurrent self password requests have one winner and cannot overwrite it`, async t => {
    const f = await fixture(t, backend);
    const alternate = 'other-concurrent-new-password';
    const results = await Promise.all([
      f.change({ currentPassword: oldPassword, newPassword }),
      f.change({ currentPassword: oldPassword, newPassword: alternate }, f.second),
    ]);
    assert.deepEqual(results.map(response => response.statusCode).sort(), [204, 401]);
    const winner = results[0].statusCode === 204 ? newPassword : alternate;
    const loser = winner === newPassword ? alternate : newPassword;
    assert.equal((await f.login('self', winner)).statusCode, 200);
    assert.equal((await f.login('self', loser)).statusCode, 401);
    assert.equal(f.audits().filter(row => row.action === 'auth.password.change').length, 1);
  });

  test(`${backend}: password commit rechecks the hash and the exact current login`, async t => {
    const f = await fixture(t, backend);
    const auth = (await f.store.resolveAccess(tokenHash(f.first.accessToken), new Date().toISOString()))!;
    const change: PasswordChange = { userId: f.user.id, loginId: auth.login.id, accessHash: auth.login.accessHash,
      expectedPasswordHash: oldHash, passwordHash: newHash, now: new Date().toISOString(),
      audit: { id: randomUUID(), actorId: f.user.id, action: 'auth.password.change', createdAt: new Date().toISOString() } };
    const fails = (code: string) => (error: unknown) => error instanceof AppError && error.code === code;
    await assert.rejects(f.store.changePassword({ ...change, expectedPasswordHash: newHash }), fails('INVALID_CURRENT_PASSWORD'));
    await assert.rejects(f.store.changePassword({ ...change, userId: f.other.id }), fails('UNAUTHORIZED'));
    await assert.rejects(f.store.changePassword({ ...change, now: auth.login.accessExpiresAt }), fails('UNAUTHORIZED'));
    await assert.rejects(f.store.changePassword({ ...change, accessHash: tokenHash('stale-token') }), fails('UNAUTHORIZED'));
    await f.store.revokeLogin(auth.login.id);
    await assert.rejects(f.store.changePassword(change), fails('UNAUTHORIZED'));
    assert.equal((await f.store.findUser('self'))!.passwordHash, oldHash);
    assert.equal(f.audits().filter(row => row.action === 'auth.password.change').length, 0);
  });
}

test('SQLite audit failure rolls back password and login revocation, then change survives reopen', async t => {
  const f = await fixture(t, 'sqlite');
  const store = f.store as SqliteStore;
  store.db.exec("CREATE TRIGGER reject_password_audit BEFORE INSERT ON rufa_audit WHEN NEW.action='auth.password.change' BEGIN SELECT RAISE(ABORT,'test audit failure'); END");
  const failed = await f.change({ currentPassword: oldPassword, newPassword });
  assert.equal(failed.statusCode, 500); assert.equal(failed.json().error.code, 'INTERNAL_ERROR');
  assert.equal((await store.findUser('self'))!.passwordHash, oldHash);
  for (const credentials of [f.first, f.second]) assert.equal((await f.app.inject({ url: '/api/v1/auth/me', headers: headers(credentials) })).statusCode, 200);
  store.db.exec('DROP TRIGGER reject_password_audit');
  assert.equal((await f.change({ currentPassword: oldPassword, newPassword })).statusCode, 204);
  await f.app.close(); await store.close();
  const reopened = new SqliteStore(store.path); f.stores.push(reopened);
  const app = buildApp(reopened, configFromEnv({})); t.after(() => app.close());
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'self', password: newPassword } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'self', password: oldPassword } })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/v1/auth/me', headers: headers(f.second) })).statusCode, 401);
  assert.equal(reopened.db.prepare("SELECT count(*) AS n FROM rufa_audit WHERE action='auth.password.change'").get()!.n, 1);
});
