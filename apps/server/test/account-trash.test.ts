import { sessionAccess } from './session-access.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { ACCOUNT_RECOVERY_MS, ARCHIVED_DISPLAY_NAME } from '../src/account-lifecycle.js';
import { buildApp } from '../src/app.js';
import { configFromEnv } from '../src/config.js';
import { hashPassword, tokenHash } from '../src/security.js';
import { SqliteStore } from '../src/sqlite-store.js';
import type { AccountMutation, Store } from '../src/store.js';
import { AppError } from '../src/types.js';
import { MemoryStore } from './memory-store.js';

const password = 'account-trash-test-password';
const passwordHash = await hashPassword(password);
type Credentials = { accessToken: string; refreshToken: string; deviceId: string };
const headers = (credentials: Credentials) => ({ authorization: `Bearer ${credentials.accessToken}` });
const code = (name: string) => (error: unknown) => error instanceof AppError && error.code === name;

async function fixture(t: TestContext, backend: 'memory' | 'sqlite') {
  const stores: Store[] = [];
  let store: MemoryStore | SqliteStore;
  if (backend === 'sqlite') {
    const directory = await mkdtemp(join(tmpdir(), 'rufa-trash-test-'));
    store = new SqliteStore(join(directory, 'company.sqlite'));
    t.after(async () => {
      for (const opened of stores) await opened.close();
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('rufa-trash-test-'));
      await rm(directory, { recursive: true, force: true });
    });
  } else store = new MemoryStore();
  stores.push(store);
  const admin = await store.createUser({ username: 'admin', displayName: '管理', role: 'admin', passwordHash });
  const user = await store.createUser({ username: 'employee', displayName: '原姓名', role: 'employee', passwordHash });
  const other = await store.createUser({ username: 'other', displayName: '其他员工', role: 'employee', passwordHash });
  let clock = Date.now();
  const config = { ...configFromEnv({}), now: () => clock, accessTtlMs: ACCOUNT_RECOVERY_MS * 4, refreshTtlMs: ACCOUNT_RECOVERY_MS * 6 };
  const app = buildApp(store, config); t.after(() => app.close());
  const login = async (username: string) => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password } });
    assert.equal(response.statusCode, 200, response.body); return response.json<Credentials>();
  };
  const manager = await login('admin'), first = await login('employee'), second = await login('employee'), outsider = await login('other');
  const route = `/api/v1/admin/users/${user.id}`;
  const remove = () => app.inject({ method: 'DELETE', url: route, headers: headers(manager) });
  const restore = () => app.inject({ method: 'POST', url: `${route}/restore`, headers: headers(manager) });
  const auth = (await store.resolveAccess(tokenHash(first.accessToken), new Date(clock).toISOString()))!;
  await store.updateProfile({ userId: user.id, loginId: auth.login.id, accessHash: auth.login.accessHash, now: new Date(clock).toISOString(), displayName: user.displayName, jobTitle: '工程岗位', audit: { id: randomUUID(), actorId: user.id, action: 'auth.profile.update', createdAt: new Date(clock).toISOString() } });
  const session = await store.createSession(user.id, { id: 'archived-chat', title: '聊天档案', upstreamHeader: { id: 'original-header' } });
  const lease = await store.acquireLease(session.id, sessionAccess(auth.login, () => new Date(clock).toISOString()), 60000);
  const events = [{ seq: 0, event: { type: 'user/message', data: { content: [{ type: 'text', text: '业务聊天必须保留' }] } } }];
  await store.appendEvents(session.id, sessionAccess(auth.login, () => new Date(clock).toISOString()), lease.leaseId, 0, events);
  await store.recordUsage({ id: randomUUID(), userId: user.id, loginId: auth.login.id, model: 'mock', requestId: 'mock-request', status: 'completed', createdAt: new Date(clock).toISOString(), inputTokens: 1, outputTokens: 2, totalTokens: 3 });
  await store.saveFile({ id: 'archived-file', ownerId: user.id, metadata: { filename: 'archive.txt' }, createdAt: new Date(clock).toISOString(), deletedAt: null }, Buffer.from('attachment archive'));
  const auditRows = () => store instanceof MemoryStore ? store.audits : store.db.prepare('SELECT * FROM rufa_audit').all();
  const mutation = async (action: string): Promise<AccountMutation> => {
    const actor = (await store.resolveAccess(tokenHash(manager.accessToken), new Date(clock).toISOString()))!;
    return { userId: admin.id, loginId: actor.login.id, accessHash: actor.login.accessHash, targetId: user.id, now: new Date(clock).toISOString(), audit: { id: randomUUID(), actorId: admin.id, action, targetId: user.id, createdAt: new Date(clock).toISOString() } };
  };
  return { store, stores, app, config, user, other, admin, manager, first, second, outsider, login, route, remove, restore, mutation, session, events, auditRows, originalLogin: auth.login, time: () => clock, setTime: (value: number) => { clock = value; } };
}

for (const backend of ['memory', 'sqlite'] as const) {
  test(`${backend}: seven-day trash restores account but never its old logins, and repeated delete preserves deadline`, async t => {
    const f = await fixture(t, backend); const deleted = f.time();
    assert.equal((await f.remove()).statusCode, 204);
    const trashed = (await f.store.findUser('employee'))!;
    assert.equal(trashed.status, 'deleted'); assert.equal(trashed.deletedAt, new Date(deleted).toISOString());
    assert.equal(trashed.purgeAfter, new Date(deleted + ACCOUNT_RECOVERY_MS).toISOString()); assert.equal(trashed.purgedAt, null);
    f.setTime(deleted + 60000); assert.equal((await f.remove()).statusCode, 204);
    assert.equal((await f.store.findUser('employee'))!.purgeAfter, trashed.purgeAfter);
    assert.equal(f.auditRows().filter(row => row.action === 'admin.user.delete').length, 1);
    for (const old of [f.first, f.second]) {
      assert.equal((await f.app.inject({ url: '/api/v1/auth/me', headers: headers(old) })).statusCode, 401);
      assert.equal((await f.app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: old.refreshToken } })).statusCode, 401);
    }
    f.setTime(deleted + ACCOUNT_RECOVERY_MS - 1);
    const restored = await f.restore(); assert.equal(restored.statusCode, 200, restored.body);
    assert.equal(restored.json().user.status, 'active'); assert.equal(restored.json().user.deletedAt, null); assert.equal(restored.json().user.purgeAfter, null); assert.equal(restored.json().user.jobTitle, '工程岗位');
    assert.ok(!restored.body.includes('passwordHash'));
    assert.equal((await f.restore()).json().error.code, 'USER_NOT_DELETED');
    for (const old of [f.first, f.second]) assert.equal((await f.app.inject({ url: '/api/v1/auth/me', headers: headers(old) })).statusCode, 401);
    const fresh = await f.login('employee'); assert.notEqual(fresh.deviceId, f.first.deviceId);
    assert.equal((await f.app.inject({ url: '/api/v1/auth/me', headers: headers(f.outsider) })).statusCode, 200);
    assert.deepEqual(await f.store.readEvents(f.session.id, -1, 100), f.events);
    assert.equal((await f.remove()).statusCode, 204);
    assert.equal((await f.store.findUser('employee'))!.purgeAfter, new Date(f.time() + ACCOUNT_RECOVERY_MS).toISOString());
  });

  test(`${backend}: exact expiry rejects restore, removes credentials and profiles but preserves archived chats and username identity`, async t => {
    const f = await fixture(t, backend);
    assert.equal((await f.remove()).statusCode, 204);
    f.setTime(f.time() + ACCOUNT_RECOVERY_MS);
    await assert.rejects(f.store.restoreUser(await f.mutation('admin.user.restore')), code('RESTORE_EXPIRED'));
    assert.equal((await f.store.findUser('employee'))!.purgedAt, null, 'deadline check works before cleanup');
    const expired = await f.restore(); assert.equal(expired.statusCode, 409); assert.equal(expired.json().error.code, 'RESTORE_EXPIRED');
    const archived = (await f.store.findUser('employee'))!;
    assert.equal(archived.id, f.user.id); assert.equal(archived.username, 'employee'); assert.equal(archived.status, 'deleted');
    assert.equal(archived.purgedAt, new Date(f.time()).toISOString()); assert.equal(archived.passwordHash, ''); assert.equal(archived.displayName, ARCHIVED_DISPLAY_NAME); assert.equal(archived.jobTitle, '');
    assert.equal(await f.store.resolveLogin(f.originalLogin.id, new Date(f.time()).toISOString()), undefined);
    const logins = f.store instanceof MemoryStore ? [...f.store.logins.values()].filter(row => row.userId === f.user.id) : f.store.db.prepare('SELECT * FROM rufa_logins WHERE user_id=?').all(f.user.id);
    assert.equal(logins.length, 1, 'only usage-referenced login identity remains');
    const retained = JSON.stringify(logins);
    for (const value of [f.originalLogin.accessHash, f.originalLogin.refreshHash, f.originalLogin.deviceId, f.originalLogin.deviceLabel]) assert.ok(!retained.includes(value));
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'employee', password } })).statusCode, 401);
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/v1/admin/users', headers: headers(f.manager), payload: { username: 'employee', displayName: '新身份', role: 'employee', password } })).statusCode, 409);
    const list = (await f.app.inject({ url: '/api/v1/admin/users', headers: headers(f.manager) })).json().users;
    assert.equal(list.find((row: { id: string }) => row.id === f.user.id).purgedAt, archived.purgedAt);
    assert.equal((await f.app.inject({ url: `/api/v1/admin/users/${f.user.id}/sessions`, headers: headers(f.manager) })).json().sessions[0].id, f.session.id);
    assert.deepEqual((await f.app.inject({ url: `/api/v1/admin/sessions/${f.session.id}/events`, headers: headers(f.manager) })).json().events, f.events);
    assert.equal((await f.store.getFile('archived-file'))!.ownerId, f.user.id);
    assert.equal((await f.restore()).json().error.code, 'RESTORE_EXPIRED');
    assert.equal(await f.store.purgeExpiredUsers(new Date(f.time() + 1).toISOString()), 0);
    assert.equal(f.auditRows().filter(row => row.action === 'system.user.purge').length, 1);
  });

  test(`${backend}: trash operations deny employees, self deletion and stale administrator authorization`, async t => {
    const f = await fixture(t, backend);
    for (const request of [{ method: 'DELETE' as const, url: f.route }, { method: 'POST' as const, url: `${f.route}/restore` }]) assert.equal((await f.app.inject({ ...request, headers: headers(f.outsider) })).statusCode, 403);
    const self = await f.app.inject({ method: 'DELETE', url: `/api/v1/admin/users/${f.admin.id}`, headers: headers(f.manager) });
    assert.equal(self.statusCode, 400); assert.equal(self.json().error.code, 'SELF_DELETE_NOT_ALLOWED');
    assert.equal((await f.app.inject({ method: 'POST', url: `${f.route}/restore`, headers: headers(f.manager), payload: { role: 'admin' } })).statusCode, 400);
    const commit = f.store.deleteUser.bind(f.store);
    f.store.deleteUser = async change => { await f.store.revokeLogin(change.loginId); return commit(change); };
    assert.equal((await f.remove()).statusCode, 401);
    assert.equal((await f.store.findUser('employee'))!.status, 'active');
    assert.equal(f.auditRows().filter(row => row.action === 'admin.user.delete').length, 0);
  });

  test(`${backend}: restore rechecks the deadline if it expires after admission`, async t => {
    const f = await fixture(t, backend); assert.equal((await f.remove()).statusCode, 204);
    const deadline = Date.parse((await f.store.findUser('employee'))!.purgeAfter!);
    f.setTime(deadline - 1);
    const admitted = await f.mutation('admin.user.restore');
    await assert.rejects(f.store.restoreUser(admitted, () => new Date(deadline).toISOString()), code('RESTORE_EXPIRED'));
    assert.equal((await f.store.findUser('employee'))!.status, 'deleted');
    assert.equal(f.auditRows().filter(row => row.action === 'admin.user.restore').length, 0);
  });
}

test('SQLite periodic cleanup purges expired trash within its next minute without an API read', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = await fixture(t, 'sqlite');
  assert.equal((await f.remove()).statusCode, 204);
  f.setTime(f.time() + ACCOUNT_RECOVERY_MS);
  t.mock.timers.tick(59999); await nextTurn();
  assert.equal((await f.store.findUser('employee'))!.purgedAt, null);
  t.mock.timers.tick(1); await nextTurn();
  assert.equal((await f.store.findUser('employee'))!.purgedAt, new Date(f.time()).toISOString());
  await f.app.close();
});

test('SQLite startup cleanup purges overdue accounts after downtime and keeps chat ownership', async t => {
  const f = await fixture(t, 'sqlite'); const old = f.store as SqliteStore;
  assert.equal((await f.remove()).statusCode, 204);
  await f.app.close(); await old.close();
  f.setTime(f.time() + ACCOUNT_RECOVERY_MS + 1234);
  const reopened = new SqliteStore(old.path); f.stores.push(reopened);
  const app = buildApp(reopened, f.config); t.after(() => app.close());
  await app.ready();
  assert.equal((await reopened.findUser('employee'))!.passwordHash, '');
  assert.equal((await reopened.findUser('employee'))!.purgedAt, new Date(f.time()).toISOString());
  assert.equal((await reopened.getSession(f.session.id))!.ownerId, f.user.id);
  assert.deepEqual(await reopened.readEvents(f.session.id, -1, 100), f.events);
});

test('SQLite delete, restore and purge audit failures roll back their entire mutation', async t => {
  const f = await fixture(t, 'sqlite'); const store = f.store as SqliteStore;
  const failAudit = (action: string) => store.db.exec(`CREATE TRIGGER reject_trash_audit BEFORE INSERT ON rufa_audit WHEN NEW.action='${action}' BEGIN SELECT RAISE(ABORT,'test audit failure'); END`);
  const clearAudit = () => store.db.exec('DROP TRIGGER reject_trash_audit');
  failAudit('admin.user.delete'); assert.equal((await f.remove()).statusCode, 500);
  assert.equal((await store.findUser('employee'))!.status, 'active'); assert.ok(await store.resolveAccess(f.originalLogin.accessHash, new Date(f.time()).toISOString()));
  clearAudit(); assert.equal((await f.remove()).statusCode, 204);
  failAudit('admin.user.restore'); assert.equal((await f.restore()).statusCode, 500);
  assert.equal((await store.findUser('employee'))!.status, 'deleted');
  clearAudit(); assert.equal((await f.restore()).statusCode, 200); assert.equal(await store.resolveAccess(f.originalLogin.accessHash, new Date(f.time()).toISOString()), undefined);
  assert.equal((await f.remove()).statusCode, 204); f.setTime(f.time() + ACCOUNT_RECOVERY_MS);
  failAudit('system.user.purge'); await assert.rejects(store.purgeExpiredUsers(new Date(f.time()).toISOString()));
  assert.equal((await store.findUser('employee'))!.passwordHash, passwordHash); assert.equal((await store.findUser('employee'))!.purgedAt, null);
  assert.equal(store.db.prepare('SELECT access_hash FROM rufa_logins WHERE id=?').get(f.originalLogin.id)!.access_hash, f.originalLogin.accessHash);
  clearAudit(); assert.equal(await store.purgeExpiredUsers(new Date(f.time()).toISOString()), 1);
  assert.equal((await store.findUser('employee'))!.passwordHash, '');
});

test('SQLite v2 upgrade gives legacy deleted accounts exactly one recovery window', async t => {
  const f = await fixture(t, 'sqlite'); const old = f.store as SqliteStore;
  assert.equal((await f.remove()).statusCode, 204); await f.app.close();
  old.db.exec('ALTER TABLE rufa_users DROP COLUMN deleted_at; ALTER TABLE rufa_users DROP COLUMN purge_after; ALTER TABLE rufa_users DROP COLUMN purged_at; PRAGMA user_version=2');
  await old.close(); const before = Date.now();
  const reopened = new SqliteStore(old.path); f.stores.push(reopened);
  const legacy = (await reopened.findUser('employee'))!;
  assert.equal(reopened.db.prepare('PRAGMA user_version').get()!.user_version, 4);
  assert.equal(legacy.status, 'deleted'); assert.equal(legacy.purgedAt, null); assert.equal(legacy.passwordHash, passwordHash); assert.equal(legacy.jobTitle, '工程岗位');
  assert.ok(Date.parse(legacy.deletedAt!) >= before && Date.parse(legacy.deletedAt!) <= Date.now());
  assert.equal(Date.parse(legacy.purgeAfter!) - Date.parse(legacy.deletedAt!), ACCOUNT_RECOVERY_MS);
  await reopened.close();
  const again = new SqliteStore(old.path); f.stores.push(again);
  assert.equal((await again.findUser('employee'))!.purgeAfter, legacy.purgeAfter);
  assert.deepEqual(await again.readEvents(f.session.id, -1, 100), f.events);
});
