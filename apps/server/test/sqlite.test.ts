import { sessionAccess } from './session-access.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { buildApp } from '../src/app.js';
import { configFromEnv } from '../src/config.js';
import { hashPassword, makeToken, tokenHash, verifyPassword } from '../src/security.js';
import { SqliteStore } from '../src/sqlite-store.js';
import { AppError, type Login } from '../src/types.js';
import { MemoryStore } from './memory-store.js';
import type { ProfileChange } from '../src/store.js';
import { ACCOUNT_RECOVERY_MS } from '../src/account-lifecycle.js';
import { parsePreferenceMutation } from '../src/preferences.js';

const password = 'SQLite-test-password-2026';
const passwordHash = await hashPassword(password);
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'rufa-sqlite-test-'));
  const path = join(directory, 'company.sqlite');
  const stores: SqliteStore[] = [];
  const open = () => { const store = new SqliteStore(path); stores.push(store); return store; };
  t.after(async () => { for (const store of stores) await store.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, path, open, store: open() };
}
async function addUsers(store: SqliteStore) {
  const admin = await store.createUser({ username: 'admin', displayName: '管理', role: 'admin', passwordHash }, true);
  const alice = await store.createUser({ username: 'alice', displayName: '员工甲', role: 'employee', passwordHash });
  const bob = await store.createUser({ username: 'bob', displayName: '员工乙', role: 'employee', passwordHash });
  return { admin, alice, bob };
}
function loginFor(userId: string): Login {
  const now = Date.now();
  return { id: randomUUID(), userId, deviceId: randomUUID(), deviceLabel: 'SQLite测试', accessHash: tokenHash(makeToken()), refreshHash: tokenHash(makeToken()), accessExpiresAt: new Date(now + 60_000).toISOString(), refreshExpiresAt: new Date(now + 86400000).toISOString(), revokedAt: null, createdAt: new Date(now).toISOString() };
}
const code = (expected: string) => (error: unknown) => error instanceof AppError && error.code === expected;

async function raceProcesses(t: TestContext, path: string, commands: Record<string, unknown>[]) {
  const workers = commands.map(() => fork(fileURLToPath(new URL('./sqlite-race-worker.ts', import.meta.url)), [path], { execArgv: ['--import', 'tsx'], silent: true }));
  t.after(() => { for (const worker of workers) if (worker.exitCode === null) worker.kill(); });
  await Promise.all(workers.map(worker => new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('SQLite worker did not initialize')), 10000); timeout.unref();
    worker.once('error', reject);
    worker.once('message', message => { clearTimeout(timeout); if ((message as any).status === 'ready') resolve(); else reject(new Error('Unexpected worker state')); });
  })));
  const pending = workers.map(worker => new Promise<{ status: string; code?: string }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('SQLite worker did not finish')), 10000); timeout.unref();
    worker.once('error', reject);
    worker.once('message', message => { clearTimeout(timeout); resolve(message as { status: string; code?: string }); });
  }));
  workers.forEach((worker, index) => worker.send(commands[index]));
  const results = await Promise.all(pending);
  await Promise.all(workers.map(worker => worker.exitCode !== null ? Promise.resolve() : new Promise<void>(resolve => worker.once('exit', () => resolve()))));
  return results;
}

test('independent preference processes serialize CAS and idempotency without duplicate history', async t => {
  const f = await fixture(t), { alice } = await addUsers(f.store), login = loginFor(alice.id);
  await f.store.createLogin(login, passwordHash);
  const access = { userId: alice.id, loginId: login.id, accessHash: login.accessHash };
  const entry = { id: randomUUID(), scope: 'account', category: 'general', topic: '偏好', text: 'A', enabled: true };
  const mutation = parsePreferenceMutation({ mutationId: randomUUID(), operation: 'put', expectedVersion: 0, entry });
  const duplicate = await raceProcesses(t, f.path, [0, 1].map(() => ({ operation: 'preferences', access, mutation })));
  assert.ok(duplicate.every(row => row.status === 'ok'));
  const args = { ...access, now: () => new Date().toISOString() };
  assert.equal((await f.store.getPreferenceHistory(args, { limit: 100 })).history.length, 1);
  const competing = await raceProcesses(t, f.path, ['B', 'C'].map(text => ({ operation: 'preferences', access, mutation: parsePreferenceMutation({ mutationId: randomUUID(), operation: 'put', expectedVersion: 1, entry: { ...entry, text } }) })));
  assert.equal(competing.filter(row => row.status === 'ok').length, 1);
  assert.equal(competing.filter(row => row.code === 'PREFERENCE_CONFLICT').length, 1);
  const snapshot = await f.store.getPreferences(args); assert.equal(snapshot.revision, 2); assert.equal(snapshot.entries[0].version, 2);
  assert.equal((await f.store.getPreferenceHistory(args, { limit: 100 })).history.length, 2);
});

test('real SQLite persists accounts, complete events, tokens, files, usage and audit across reopen', async t => {
  const f = await fixture(t); const { admin, alice } = await addUsers(f.store);
  assert.equal(f.store.db.prepare('PRAGMA journal_mode').get()!.journal_mode, 'wal');
  assert.equal(f.store.db.prepare('PRAGMA foreign_keys').get()!.foreign_keys, 1);
  const login = loginFor(alice.id); await f.store.createLogin(login, passwordHash);
  const header = { id: 'persisted-session', cwd: 'C:\\Work', custom: { all: ['original', 'fields'] } };
  const session = await f.store.createSession(alice.id, { id: 'persisted-session', title: '真实持久化', upstreamHeader: header, inheritedEventCount: 2 });
  const lease = await f.store.acquireLease(session.id, sessionAccess(login), 60000);
  const events = [{ seq: 0, event: { type: 'user/message', content: [{ type: 'text', text: '保存任务' }] } }, { seq: 1, event: { type: 'tool/result', result: { full: [1, 2, 3] }, extension: '原版扩展字段' } }];
  await f.store.appendEvents(session.id, sessionAccess(login), lease.leaseId, 0, events);
  await f.store.saveFile({ id: 'sqlite-file', ownerId: alice.id, metadata: { id: 'sqlite-file', type: 'file', filename: 'photo.png' }, createdAt: new Date().toISOString(), deletedAt: null }, Buffer.from([0, 1, 2, 255]));
  await f.store.audit({ id: randomUUID(), actorId: admin.id, action: 'admin.session.events.read', targetId: session.id, createdAt: new Date().toISOString() });
  await f.store.recordUsage({ id: randomUUID(), userId: alice.id, loginId: login.id, model: 'deepseek-flash', requestId: 'request-1', status: 'completed', createdAt: new Date().toISOString(), inputTokens: 3, outputTokens: 4, totalTokens: 7 });
  await f.store.close();
  const reopened = f.open();
  assert.equal((await reopened.findUser('alice'))!.id, alice.id);
  assert.deepEqual((await reopened.getSession(session.id))!.upstreamHeader, header);
  assert.equal((await reopened.getSession(session.id))!.inheritedEventCount, 2);
  assert.deepEqual(await reopened.readEvents(session.id, -1, 100), events);
  assert.equal((await reopened.resolveAccess(login.accessHash, new Date().toISOString()))!.user.id, alice.id);
  assert.equal((await reopened.getFile('sqlite-file'))!.ownerId, alice.id);
  assert.deepEqual(Buffer.from(reopened.db.prepare('SELECT contents FROM rufa_upstream_files WHERE id=?').get('sqlite-file')!.contents as Uint8Array), Buffer.from([0, 1, 2, 255]));
  assert.equal(reopened.db.prepare('SELECT count(*) AS n FROM rufa_audit').get()!.n, 1);
  assert.equal(reopened.db.prepare('SELECT total_tokens FROM rufa_usage').get()!.total_tokens, 7);
});

test('SQLite transactions preserve last admin and revoke refresh replay/disabled accounts', async t => {
  const f = await fixture(t); const { admin, alice } = await addUsers(f.store);
  await assert.rejects(f.store.updateUser(admin.id, { status: 'deleted' }), code('LAST_ADMIN'));
  const admin2 = await f.store.createUser({ username: 'admin2', displayName: '管理二', role: 'admin', passwordHash });
  const other = f.open();
  const results = await Promise.allSettled([f.store.updateUser(admin.id, { status: 'disabled' }), other.updateUser(admin2.id, { role: 'employee' })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await f.store.listUsers()).filter(user => user.role === 'admin' && user.status === 'active').length, 1);
  const login = loginFor(alice.id); await f.store.createLogin(login, passwordHash);
  const rotated = { accessHash: tokenHash(makeToken()), refreshHash: tokenHash(makeToken()), accessExpiresAt: login.accessExpiresAt, refreshExpiresAt: login.refreshExpiresAt };
  assert.ok(await f.store.rotateRefresh(login.refreshHash, rotated, new Date().toISOString()));
  assert.ok(await other.resolveLogin(login.id, new Date().toISOString()));
  assert.equal(await other.rotateRefresh(login.refreshHash, rotated, new Date().toISOString()), undefined);
  assert.equal(await f.store.resolveAccess(rotated.accessHash, new Date().toISOString()), undefined);
  const next = loginFor(alice.id); await f.store.createLogin(next, passwordHash);
  await f.store.updateUser(alice.id, { status: 'disabled' });
  assert.equal(await other.resolveAccess(next.accessHash, new Date().toISOString()), undefined);
});

test('SQLite v1 migration adds empty job titles while preserving accounts, tokens and session history', async t => {
  const f = await fixture(t); const { alice } = await addUsers(f.store);
  const login = loginFor(alice.id); await f.store.createLogin(login, passwordHash);
  const session = await f.store.createSession(alice.id, { id: 'migration-history', title: '保留历史' });
  const now = new Date().toISOString();
  const lease = await f.store.acquireLease(session.id, sessionAccess(login, now), 60000);
  const events = [{ seq: 0, event: { type: 'user/message', data: { text: '原有记录' } } }];
  await f.store.appendEvents(session.id, sessionAccess(login), lease.leaseId, 0, events);
  // Reconstruct the exact v1 users schema; all other tables are unchanged in v2.
  f.store.db.exec('ALTER TABLE rufa_users DROP COLUMN job_title; ALTER TABLE rufa_users DROP COLUMN deleted_at; ALTER TABLE rufa_users DROP COLUMN purge_after; ALTER TABLE rufa_users DROP COLUMN purged_at; PRAGMA user_version=1');
  assert.equal(f.store.db.prepare('PRAGMA user_version').get()!.user_version, 1);
  await f.store.close();
  const migrated = f.open();
  assert.equal(migrated.db.prepare('PRAGMA user_version').get()!.user_version, 4);
  assert.ok((await migrated.listUsers()).every(user => user.jobTitle === ''));
  assert.equal((await migrated.findUser('alice'))!.passwordHash, passwordHash);
  assert.equal((await migrated.resolveAccess(login.accessHash, now))!.user.id, alice.id);
  assert.deepEqual(await migrated.readEvents(session.id, -1, 100), events);
  const created = await migrated.createUser({ username: 'after-upgrade', displayName: '升级后', role: 'employee', passwordHash });
  assert.equal(created.jobTitle, '');
  await migrated.close();
  const reopened = f.open();
  assert.equal((await reopened.listUsers()).length, 4);
  assert.equal(reopened.db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
});

test('SQLite enforces leases, idempotent batches and transactional rollback of partial writes', async t => {
  const f = await fixture(t); const { alice } = await addUsers(f.store);
  const first = loginFor(alice.id); const second = loginFor(alice.id);
  await f.store.createLogin(first, passwordHash); await f.store.createLogin(second, passwordHash);
  const session = await f.store.createSession(alice.id, { id: 'ordered-events' });
  const now = new Date().toISOString(); const expires = new Date(Date.now() + 60000).toISOString();
  const lease = await f.store.acquireLease(session.id, sessionAccess(first, now), Date.parse(expires) - Date.parse(now));
  const other = f.open();
  await assert.rejects(other.acquireLease(session.id, sessionAccess(second, now), Date.parse(expires) - Date.parse(now)), code('LEASE_CONFLICT'));
  const batch = [{ seq: 0, event: { type: 'user/message', text: '原始内容' } }];
  assert.equal(await f.store.appendEvents(session.id, sessionAccess(first), lease.leaseId, 0, batch), 1);
  assert.equal(await other.appendEvents(session.id, sessionAccess(first), lease.leaseId, 0, batch), 1);
  await assert.rejects(other.appendEvents(session.id, sessionAccess(first), lease.leaseId, 0, [{ seq: 0, event: { type: 'user/message', text: '改写历史' } }]), code('SEQUENCE_CONFLICT'));
  // Direct Store misuse simulates a later SQL failure in a batch: nothing may commit.
  await assert.rejects(other.appendEvents(session.id, sessionAccess(first), lease.leaseId, 1, [{ seq: 1, event: { type: 'step/start' } }, { seq: 1, event: { type: 'step/end' } }]));
  assert.equal((await f.store.getSession(session.id))!.nextSeq, 1); assert.equal((await f.store.readEvents(session.id, -1, 100)).length, 1);
  await f.store.revokeLogin(first.id);
  const recovered = await other.acquireLease(session.id, sessionAccess(second, now), Date.parse(expires) - Date.parse(now));
  assert.notEqual(recovered.leaseId, lease.leaseId); assert.equal(recovered.nextSeq, 1);
});

test('real SQLite HTTP employee isolation and admin read-only review survive restart', async t => {
  const f = await fixture(t); const { admin, alice, bob } = await addUsers(f.store);
  const app = buildApp(f.store, configFromEnv({}), () => f.store.ping()); t.after(() => app.close());
  const login = async (username: string) => (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password } })).json();
  const adminLogin = await login('admin'); const aliceLogin = await login('alice'); const bobLogin = await login('bob');
  const auth = (value: { accessToken: string }) => ({ authorization: `Bearer ${value.accessToken}` });
  const session = (await app.inject({ method: 'POST', url: '/api/v1/sessions', headers: auth(aliceLogin), payload: { title: '私有会话', ownerId: bob.id } })).json().session;
  assert.equal(session.ownerId, alice.id);
  assert.equal((await app.inject({ url: `/api/v1/sessions/${session.id}`, headers: auth(bobLogin) })).statusCode, 404);
  assert.equal((await app.inject({ url: '/api/v1/admin/users', headers: auth(aliceLogin) })).statusCode, 403);
  assert.equal((await app.inject({ url: `/api/v1/admin/sessions/${session.id}/events`, headers: auth(adminLogin) })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: `/api/v1/sessions/${session.id}/lease`, headers: auth(adminLogin), payload: { deviceId: adminLogin.deviceId } })).statusCode, 404);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM rufa_audit WHERE actor_id=? AND action='admin.session.events.read'").get(admin.id)!.n, 1);
  await app.close(); await f.store.close();
  const reopened = f.open();
  assert.equal((await reopened.listSessions(alice.id, 100)).length, 1);
  assert.equal((await reopened.listSessions(bob.id, 100)).length, 0);
});

test('SQLite online backup captures committed WAL data and can be reopened independently', async t => {
  const f = await fixture(t); const { alice } = await addUsers(f.store);
  f.store.db.exec('PRAGMA wal_autocheckpoint=0');
  await f.store.createSession(alice.id, { id: 'before-backup', title: '快照前' });
  const destination = join(f.directory, 'snapshot.sqlite');
  await f.store.backupTo(destination);
  await f.store.createSession(alice.id, { id: 'after-backup', title: '快照后' });
  const snapshot = new SqliteStore(destination);
  try {
    assert.equal((await snapshot.findUser('alice'))!.id, alice.id);
    assert.ok(await snapshot.getSession('before-backup'));
    assert.equal(await snapshot.getSession('after-backup'), undefined);
    assert.equal(snapshot.db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
  } finally { await snapshot.close(); }
  await assert.rejects(f.store.backupTo(f.path));
  await assert.rejects(f.store.backupTo(destination));
});

test('independent server processes cannot disable both remaining administrators', async t => {
  const f = await fixture(t); const { admin } = await addUsers(f.store);
  const otherAdmin = await f.store.createUser({ username: 'concurrent-admin', displayName: '第二管理', role: 'admin', passwordHash });
  const results = await raceProcesses(t, f.path, [{ operation: 'disable', userId: admin.id }, { operation: 'disable', userId: otherAdmin.id }]);
  assert.equal(results.filter(result => result.status === 'ok').length, 1);
  assert.equal(results.filter(result => result.code === 'LAST_ADMIN').length, 1);
  assert.equal((await f.store.listUsers()).filter(user => user.role === 'admin' && user.status === 'active').length, 1);
});

test('independent processes cannot commit two self password changes from the same old hash', async t => {
  const f = await fixture(t); const { alice } = await addUsers(f.store);
  const first = loginFor(alice.id), second = loginFor(alice.id);
  await f.store.createLogin(first, passwordHash); await f.store.createLogin(second, passwordHash);
  const passwords = ['first-new-password-2026', 'second-new-password-2026'];
  const hashes = await Promise.all(passwords.map(value => hashPassword(value)));
  const now = new Date().toISOString();
  const results = await raceProcesses(t, f.path, [first, second].map((login, index) => ({ operation: 'change-password', change: {
    userId: alice.id, loginId: login.id, accessHash: login.accessHash, expectedPasswordHash: passwordHash,
    passwordHash: hashes[index], now,
    audit: { id: randomUUID(), actorId: alice.id, action: 'auth.password.change', createdAt: now },
  } })));
  assert.equal(results.filter(result => result.status === 'ok').length, 1);
  assert.equal(results.filter(result => result.code === 'UNAUTHORIZED').length, 1);
  const winner = results.findIndex(result => result.status === 'ok');
  const saved = (await f.store.findUser('alice'))!;
  assert.ok(await verifyPassword(passwords[winner], saved.passwordHash));
  assert.equal(await verifyPassword(passwords[1 - winner], saved.passwordHash), false);
  assert.equal(await f.store.resolveLogin(first.id, now), undefined);
  assert.equal(await f.store.resolveLogin(second.id, now), undefined);
  await assert.rejects(f.store.createLogin(loginFor(alice.id), passwordHash), code('UNAUTHORIZED'));
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM rufa_audit WHERE action='auth.password.change'").get()!.n, 1);
});

test('independent profile writes serialize with account disable and login revocation', async t => {
  const f = await fixture(t);
  for (const operation of ['disable', 'revoke']) {
    const owner = await f.store.createUser({ username: `race-${operation}`, displayName: '原姓名', role: 'employee', passwordHash });
    const login = loginFor(owner.id); await f.store.createLogin(login, passwordHash);
    const now = new Date().toISOString();
    const change: ProfileChange = { userId: owner.id, loginId: login.id, accessHash: login.accessHash, now, displayName: '新姓名', jobTitle: '新职位',
      audit: { id: randomUUID(), actorId: owner.id, action: 'auth.profile.update', createdAt: now } };
    const results = await raceProcesses(t, f.path, [{ operation: 'profile', change }, { operation, userId: owner.id, loginId: login.id }]);
    assert.equal(results[1].status, 'ok');
    assert.ok(results[0].status === 'ok' || results[0].code === 'UNAUTHORIZED');
    const updated = results[0].status === 'ok';
    const saved = (await f.store.findUser(owner.username))!;
    assert.equal(saved.displayName, updated ? '新姓名' : '原姓名');
    assert.equal(saved.jobTitle, updated ? '新职位' : '');
    assert.equal(saved.status, operation === 'disable' ? 'disabled' : 'active');
    assert.equal(await f.store.resolveAccess(login.accessHash, now), undefined);
    await assert.rejects(f.store.updateProfile({ ...change, displayName: '越权写入' }), code('UNAUTHORIZED'));
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM rufa_audit WHERE actor_id=? AND action='auth.profile.update'").get(owner.id)!.n, updated ? 1 : 0);
  }
});

test('independent expired restore and cleanup never revive a purged account or lose its chat', async t => {
  const f = await fixture(t); const { admin, alice } = await addUsers(f.store);
  const time = Date.now(), now = new Date(time).toISOString();
  const manager = { ...loginFor(admin.id), accessExpiresAt: new Date(time + ACCOUNT_RECOVERY_MS * 2).toISOString() };
  await f.store.createLogin(manager, passwordHash);
  const session = await f.store.createSession(alice.id, { title: '不可丢失的归档' });
  const change = { userId: admin.id, loginId: manager.id, accessHash: manager.accessHash, targetId: alice.id, now,
    audit: { id: randomUUID(), actorId: admin.id, targetId: alice.id, action: 'admin.user.delete', createdAt: now } };
  await f.store.deleteUser(change);
  const expired = new Date(time + ACCOUNT_RECOVERY_MS).toISOString();
  const results = await raceProcesses(t, f.path, [
    { operation: 'restore', change: { ...change, now: expired, audit: { ...change.audit, id: randomUUID(), action: 'admin.user.restore', createdAt: expired } } },
    { operation: 'purge', now: expired },
  ]);
  assert.equal(results[0].code, 'RESTORE_EXPIRED'); assert.equal(results[1].status, 'ok');
  const archived = (await f.store.findUser('alice'))!;
  assert.equal(archived.status, 'deleted'); assert.equal(archived.passwordHash, ''); assert.equal(archived.purgedAt, expired);
  assert.equal((await f.store.getSession(session.id))!.ownerId, alice.id);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM rufa_audit WHERE action='system.user.purge'").get()!.n, 1);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM rufa_audit WHERE action='admin.user.restore'").get()!.n, 0);
});

test('independent server processes cannot overwrite competing session appends', async t => {
  const f = await fixture(t); const { alice } = await addUsers(f.store);
  const login = loginFor(alice.id); await f.store.createLogin(login, passwordHash);
  const session = await f.store.createSession(alice.id, { id: 'process-race' });
  const lease = await f.store.acquireLease(session.id, sessionAccess(login), 60000);
  const command = { operation: 'append', sessionId: session.id, access: { userId: login.userId, loginId: login.id, accessHash: login.accessHash }, leaseId: lease.leaseId };
  const results = await raceProcesses(t, f.path, [{ ...command, text: 'first process' }, { ...command, text: 'second process' }]);
  assert.equal(results.filter(result => result.status === 'ok').length, 1);
  assert.equal(results.filter(result => result.code === 'SEQUENCE_CONFLICT').length, 1);
  assert.equal((await f.store.getSession(session.id))!.nextSeq, 1);
  assert.equal((await f.store.readEvents(session.id, -1, 100)).length, 1);
});

test('session title projection keeps newest valid title, preserves raw events and ignores old retries', async t => {
  const f = await fixture(t);
  for (const store of [f.store, new MemoryStore()]) {
    const owner = await store.createUser({ username: 'title-owner', displayName: '标题测试', role: 'employee', passwordHash });
    const login = loginFor(owner.id); await store.createLogin(login, passwordHash);
    const session = await store.createSession(owner.id, { id: 'title-session' });
    const now = new Date().toISOString();
    const lease = await store.acquireLease(session.id, sessionAccess(login, now), 60000);
    const batch = [
      { seq: 0, event: { type: 'session/title', data: { title: '初始自动标题' } } },
      { seq: 1, event: { type: 'session/title', data: { title: '  BOM采购表整理  ' } } },
      { seq: 2, event: { type: 'session/title', data: { title: '   ' } } },
      { seq: 3, event: { type: 'session/title', data: { title: '长'.repeat(501) } } },
    ];
    await store.appendEvents(session.id, sessionAccess(login), lease.leaseId, 0, batch);
    assert.equal((await store.getSession(session.id))!.title, 'BOM采购表整理');
    assert.equal((await store.listSessions(owner.id, 100))[0].title, 'BOM采购表整理');
    assert.deepEqual(await store.readEvents(session.id, -1, 100), batch, 'projection must not trim/rewrite stored events');
    await store.appendEvents(session.id, sessionAccess(login), lease.leaseId, 4, [{ seq: 4, event: { type: 'session/title', data: { title: '员工手动重命名' } } }]);
    assert.equal(await store.appendEvents(session.id, sessionAccess(login), lease.leaseId, 0, batch), 5);
    assert.equal((await store.getSession(session.id))!.title, '员工手动重命名', 'old idempotent retry cannot roll the title back');
  }
  await f.store.close();
  assert.equal((await f.open().getSession('title-session'))!.title, '员工手动重命名');
});
