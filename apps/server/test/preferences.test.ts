import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { buildApp } from '../src/app.js';
import { configFromEnv } from '../src/config.js';
import { emptyPreferences, parsePreferenceMutation, type PreferenceAccess, type PreferenceInput, type PreferenceMutation } from '../src/preferences.js';
import { makeToken, tokenHash } from '../src/security.js';
import { SqliteStore } from '../src/sqlite-store.js';
import { AppError } from '../src/types.js';
import { MemoryStore } from './memory-store.js';
import { ACCOUNT_RECOVERY_MS } from '../src/account-lifecycle.js';

const url = '/api/v1/preferences';
const entry = (patch: Partial<PreferenceInput> = {}): PreferenceInput => ({ id: randomUUID(), scope: 'account', category: 'general', topic: '交付格式', text: '优先交付可编辑文档', enabled: true, ...patch });
const put = (value = entry(), expectedVersion = 0): PreferenceMutation => ({ mutationId: randomUUID(), operation: 'put', expectedVersion, entry: value });
const errorCode = (code: string) => (error: unknown) => error instanceof AppError && error.code === code;
async function fixture(t: TestContext, backend: 'memory' | 'sqlite') {
  const directory = backend === 'sqlite' ? await mkdtemp(join(tmpdir(), 'rufa-preferences-test-')) : undefined;
  const store = directory ? new SqliteStore(join(directory, 'test.sqlite')) : new MemoryStore();
  const stores = [store];
  t.after(async () => { for (const current of stores) await current.close(); if (directory) { assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('rufa-preferences-test-')); await rm(directory, { recursive: true, force: true }); } });
  let clock = Date.now();
  const config = configFromEnv({}); config.now = () => clock;
  const app = buildApp(store, config); t.after(() => app.close());
  const credentials = async (username: string, role: 'employee' | 'admin' = 'employee') => {
    const user = await store.createUser({ username, displayName: username, role, passwordHash: 'test-only-hash' });
    const token = makeToken(), time = new Date(clock).toISOString();
    const auth = await store.createLogin({ id: randomUUID(), userId: user.id, deviceId: randomUUID(), deviceLabel: 'test', accessHash: tokenHash(token), refreshHash: tokenHash(makeToken()), accessExpiresAt: new Date(clock + 3600000).toISOString(), refreshExpiresAt: new Date(clock + 86400000).toISOString(), createdAt: time, revokedAt: null }, user.passwordHash);
    const access: PreferenceAccess = { userId: user.id, loginId: auth.login.id, accessHash: auth.login.accessHash, now: () => new Date(clock).toISOString() };
    return { user, token, auth, access, headers: { authorization: `Bearer ${token}` } };
  };
  const alice = await credentials('alice'), bob = await credentials('bob'), admin = await credentials('admin', 'admin');
  const mutate = (payload: unknown, owner = alice) => app.inject({ method: 'POST', url: `${url}/mutations`, headers: owner.headers, payload: payload as any });
  const snapshot = async (owner = alice) => { const r = await app.inject({ url, headers: owner.headers }); assert.equal(r.statusCode, 200, r.body); return r.json(); };
  const history = async (query = '', owner = alice) => { const r = await app.inject({ url: `${url}/history${query}`, headers: owner.headers }); assert.equal(r.statusCode, 200, r.body); return r.json(); };
  return { store, stores, directory, app, alice, bob, admin, mutate, snapshot, history, advance: (ms: number) => { clock += ms; } };
}

for (const backend of ['memory', 'sqlite'] as const) {
  test(`${backend}: preferences scope, full replacement, switches, tombstones and explicit undo`, async t => {
    const f = await fixture(t, backend); assert.deepEqual(await f.snapshot(), emptyPreferences());
    const first = entry(), create = await f.mutate(put(first)); assert.equal(create.statusCode, 200, create.body);
    const initial = create.json(); assert.equal(initial.snapshot.entries[0].version, 1); assert.equal(initial.snapshot.entries[0].deletedAt, null);
    const project = entry({ scope: 'project', projectRef: randomUUID(), projectName: '机械设计', enabled: false });
    assert.equal((await f.mutate(put(project))).statusCode, 200);
    const edit = await f.mutate(put({ ...first, text: '先交付Excel', enabled: false }, 1)); assert.equal(edit.json().snapshot.entries[0].version, 2);
    const setting = await f.mutate({ mutationId: randomUUID(), operation: 'settings', expectedVersion: 0, enabled: false }); assert.deepEqual(setting.json().snapshot.settings, { enabled: false, version: 1 });
    const deletion = await f.mutate({ mutationId: randomUUID(), operation: 'delete', expectedVersion: 2, id: first.id }); assert.equal(deletion.statusCode, 200);
    const deleted = deletion.json().snapshot.entries[0]; assert.ok(deleted.deletedAt); assert.equal(deleted.version, 3); assert.equal(deleted.text, '先交付Excel');
    for (const version of [0, 1, 2]) { const stale = await f.mutate(put(first, version)); assert.equal(stale.statusCode, 409); assert.equal(stale.json().snapshot.entries[0].version, 3); }
    assert.equal((await f.mutate({ mutationId: randomUUID(), operation: 'delete', expectedVersion: 3, id: first.id })).statusCode, 409);
    const restored = await f.mutate(put(first, 3)); assert.equal(restored.statusCode, 200); assert.equal(restored.json().snapshot.entries[0].deletedAt, null); assert.equal(restored.json().snapshot.entries[0].version, 4); assert.equal(restored.json().snapshot.entries[0].createdAt, initial.snapshot.entries[0].createdAt);
    const histories = (await f.history()).history; const deletionHistory = histories.find((h: any) => h.operation === 'delete');
    assert.equal(deletionHistory.entries[0].before.version, 2); assert.ok(deletionHistory.entries[0].after.deletedAt);
    assert.equal(histories[0].entries[0].before.version, 3); assert.equal(histories[0].entries[0].after.version, 4);
    assert.deepEqual(await f.snapshot(f.bob), emptyPreferences()); assert.deepEqual(await f.snapshot(f.admin), emptyPreferences());
    assert.deepEqual((await f.history('', f.bob)).history, []);
  });

  test(`${backend}: independent CAS, clear atomicity and history pagination`, async t => {
    const f = await fixture(t, backend); const a = entry(), b = entry(); await f.mutate(put(a)); await f.mutate(put(b));
    const results = await Promise.all([f.mutate(put({ ...a, text: 'A' }, 1)), f.mutate(put({ ...a, text: 'B' }, 1))]);
    assert.deepEqual(results.map(r => r.statusCode).sort(), [200, 409]);
    assert.equal((await f.mutate(put({ ...b, enabled: false }, 1))).statusCode, 200);
    assert.equal((await f.mutate({ mutationId: randomUUID(), operation: 'clear', expectedRevision: 2 })).statusCode, 409);
    const before = await f.snapshot(); const clear = await f.mutate({ mutationId: randomUUID(), operation: 'clear', expectedRevision: before.revision });
    assert.equal(clear.statusCode, 200); const after = clear.json().snapshot;
    assert.deepEqual(after.settings, before.settings); assert.ok(after.entries.every((e: any) => e.deletedAt && e.version === 3));
    const history = await f.history('?limit=2'); assert.equal(history.history.length, 2); assert.equal(history.history[0].operation, 'clear'); assert.equal(history.history[0].entries.length, 2);
    const next = await f.history(`?limit=2&beforeRevision=${history.nextBeforeRevision}`); assert.ok(next.history.every((h: any) => h.revision < history.nextBeforeRevision));
    assert.equal((await f.mutate({ mutationId: randomUUID(), operation: 'clear', expectedRevision: after.revision })).json().snapshot.revision, after.revision + 1);
  });

  test(`${backend}: idempotent retries preserve original result and reject reused content`, async t => {
    const f = await fixture(t, backend), mutation = put(), first = await f.mutate(mutation); assert.equal(first.statusCode, 200);
    await f.mutate(put()); const retry = await f.mutate(mutation); assert.deepEqual(retry.json(), first.json());
    assert.equal((await f.snapshot()).revision, 2); assert.equal((await f.history()).history.length, 2);
    const changed = await f.mutate({ ...mutation, entry: entry() }); assert.equal(changed.statusCode, 409); assert.equal(changed.json().error.code, 'PREFERENCE_MUTATION_REUSED'); assert.equal(changed.json().snapshot.revision, 2);
    // Canonical parse makes JSON property order and UUID capitalization immaterial.
    const unordered = { entry: { ...(mutation as any).entry, id: (mutation as any).entry.id.toUpperCase() }, expectedVersion: 0, operation: 'put', mutationId: mutation.mutationId.toUpperCase() };
    assert.deepEqual((await f.mutate(unordered)).json(), first.json());
    const other = await f.mutate(mutation, f.bob); assert.equal(other.statusCode, 200); assert.equal(other.json().snapshot.revision, 1);
    const audit = f.store instanceof SqliteStore ? f.store.db.prepare("SELECT * FROM rufa_audit WHERE action LIKE 'preferences.%'").all() : f.store.audits.filter(a => a.action.startsWith('preferences.'));
    assert.equal(audit.length, 3); const serialized = JSON.stringify(audit); for (const value of ['优先交付可编辑文档', '交付格式', f.alice.token, 'test-only-hash']) assert.ok(!serialized.includes(value));
  });

  test(`${backend}: strict fields, bounds and identity injection are rejected without writes`, async t => {
    const f = await fixture(t, backend), good = put();
    const invalid = [
      {}, { ...good, expectedVersion: '0' }, { ...good, ownerId: f.bob.user.id }, { ...good, mutationId: 'bad' }, { ...good, expectedRevision: 0 },
      ...[{ id: 'bad' }, { text: 'a'.repeat(401) }, { text: '   ' }, { topic: 'a'.repeat(81) }, { enabled: 1 }, { version: 0 }, { category: 'secret' }, { scope: 'project' }, { projectRef: randomUUID() }, { source: { sessionId: '../x' } }, { source: { sessionId: 'ok', eventSeq: -1 } }].map(patch => ({ ...good, entry: { ...(good as any).entry, ...patch } })),
      { mutationId: randomUUID(), operation: 'clear', expectedRevision: -1 }, { mutationId: randomUUID(), operation: 'settings', expectedVersion: 0, enabled: 'false' },
      { mutationId: randomUUID(), operation: 'delete', id: randomUUID() },
    ];
    for (const payload of invalid) { const r = await f.mutate(payload); assert.equal(r.statusCode, 400, JSON.stringify(payload) + r.body); }
    for (const suffix of ['?ownerId=other', '/history?ownerId=other', '/history?limit=101', '/history?limit=0', '/history?beforeRevision=-1']) assert.equal((await f.app.inject({ url: url + suffix, headers: f.alice.headers })).statusCode, 400);
    assert.equal((await f.app.inject({ method: 'POST', url: `${url}/mutations`, payload: good })).statusCode, 401);
    assert.equal((await f.app.inject({ url })).statusCode, 401); assert.equal((await f.app.inject({ url: `${url}/history` })).statusCode, 401);
    assert.deepEqual(await f.snapshot(), emptyPreferences());
    const boundary = await f.mutate(put(entry({ text: '文'.repeat(400), topic: '题'.repeat(80), scope: 'project', projectRef: randomUUID(), projectName: '名'.repeat(100) }))); assert.equal(boundary.statusCode, 200, boundary.body);
  });

  test(`${backend}: source references require own cloud session even for administrators`, async t => {
    const f = await fixture(t, backend); const session = await f.store.createSession(f.alice.user.id, {});
    const source = { sessionId: session.id, eventSeq: 0 };
    assert.equal((await f.mutate(put(entry({ source })))).statusCode, 200);
    for (const owner of [f.bob, f.admin]) assert.equal((await f.mutate(put(entry({ source })), owner)).statusCode, 404);
    assert.equal((await f.mutate(put(entry({ source: { sessionId: 'missing-session' } })))).statusCode, 404);
  });

  test(`${backend}: all reads, writes and replay recheck active login in storage`, async t => {
    const f = await fixture(t, backend), mutation = put(); await f.mutate(mutation);
    for (const access of [{ ...f.alice.access, userId: f.bob.user.id }, { ...f.alice.access, accessHash: 'stale' }, { ...f.alice.access, now: () => f.alice.auth.login.accessExpiresAt }]) {
      await assert.rejects(f.store.getPreferences(access), errorCode('UNAUTHORIZED'));
      await assert.rejects(f.store.getPreferenceHistory(access, { limit: 1 }), errorCode('UNAUTHORIZED'));
      await assert.rejects(f.store.mutatePreferences(access, mutation), errorCode('UNAUTHORIZED'));
    }
    const commit = f.store.mutatePreferences.bind(f.store);
    f.store.mutatePreferences = async (access, value) => { await f.store.revokeLogin(access.loginId); return commit(access, value); };
    assert.equal((await f.mutate(mutation)).statusCode, 401);
    // Deactivation without relying solely on token revocation is also checked.
    if (f.store instanceof SqliteStore) f.store.db.prepare("UPDATE rufa_users SET status='disabled' WHERE id=?").run(f.bob.user.id);
    else f.store.users.get(f.bob.user.id)!.status = 'disabled';
    await assert.rejects(f.store.getPreferences(f.bob.access), errorCode('UNAUTHORIZED'));
  });

  test(`${backend}: 200 live-entry limit counts disabled, preserves tombstones and permits replacement`, async t => {
    const f = await fixture(t, backend); const values = Array.from({ length: 200 }, () => entry({ enabled: false }));
    for (const value of values) await f.store.mutatePreferences(f.alice.access, parsePreferenceMutation(put(value)));
    const rejected = await f.mutate(put()); assert.equal(rejected.statusCode, 409); assert.equal(rejected.json().error.code, 'PREFERENCE_LIMIT');
    assert.equal((await f.mutate(put({ ...values[0], text: '更新现有条目' }, 1))).statusCode, 200);
    assert.equal((await f.mutate({ mutationId: randomUUID(), operation: 'delete', id: values[1].id, expectedVersion: 1 })).statusCode, 200);
    assert.equal((await f.mutate(put())).statusCode, 200);
    assert.equal((await f.snapshot()).entries.length, 201);
    assert.equal((await f.mutate(put(values[1], 2))).json().error.code, 'PREFERENCE_LIMIT');
  });

  test(`${backend}: every original response reconstructs from deltas after edits, delete, restore, settings and clear`, async t => {
    const f = await fixture(t, backend), a = entry(), b = entry(), project = entry({ scope: 'project', projectRef: randomUUID() });
    const mutations: PreferenceMutation[] = [put(a), put(b), put(project), put({ ...a, text: '变更' }, 1),
      { mutationId: randomUUID(), operation: 'settings', expectedVersion: 0, enabled: false },
      { mutationId: randomUUID(), operation: 'delete', expectedVersion: 1, id: b.id }, put(b, 2),
      { mutationId: randomUUID(), operation: 'clear', expectedRevision: 7 }, put(project, 2),
      { mutationId: randomUUID(), operation: 'settings', expectedVersion: 1, enabled: true }];
    const original = [];
    for (const mutation of mutations) { const r = await f.mutate(mutation); assert.equal(r.statusCode, 200, r.body); original.push(r.json()); }
    for (const [index, mutation] of mutations.entries()) assert.deepEqual((await f.mutate(mutation)).json(), original[index]);
    const records = f.store instanceof SqliteStore ? f.store.db.prepare('SELECT receipt FROM rufa_preference_mutations').all().map(row => JSON.parse(String(row.receipt))) : [...f.store.preferenceReceipts.values()];
    assert.ok(records.every(record => !Object.hasOwn(record, 'result') && !Object.hasOwn(record, 'snapshot')));
  });

  test(`${backend}: trash retains personal preferences for recovery; expiry purges preferences and history only`, async t => {
    const f = await fixture(t, backend); await f.mutate(put()); const session = await f.store.createSession(f.alice.user.id, {});
    const time = f.alice.access.now();
    const change = { userId: f.admin.user.id, loginId: f.admin.auth.login.id, accessHash: f.admin.auth.login.accessHash, now: time, targetId: f.alice.user.id,
      audit: { id: randomUUID(), actorId: f.admin.user.id, action: 'admin.user.delete', createdAt: time } };
    await f.store.deleteUser(change);
    const counts = () => f.store instanceof SqliteStore
      ? [Number(f.store.db.prepare('SELECT count(*) n FROM rufa_preferences WHERE user_id=?').get(f.alice.user.id)!.n), Number(f.store.db.prepare('SELECT count(*) n FROM rufa_preference_mutations WHERE user_id=?').get(f.alice.user.id)!.n)]
      : [Number(f.store.preferences.has(f.alice.user.id)), [...f.store.preferenceReceipts.keys()].filter(key => key.startsWith(`${f.alice.user.id}:`)).length];
    assert.deepEqual(counts(), [1, 1]);
    await f.store.restoreUser({ ...change, audit: { ...change.audit, id: randomUUID(), action: 'admin.user.restore' } });
    assert.deepEqual(counts(), [1, 1]);
    await f.store.deleteUser({ ...change, audit: { ...change.audit, id: randomUUID() } });
    f.advance(ACCOUNT_RECOVERY_MS); assert.equal(await f.store.purgeExpiredUsers(f.alice.access.now()), 1);
    assert.deepEqual(counts(), [0, 0]); assert.ok(await f.store.getSession(session.id));
    await assert.rejects(f.store.getPreferences(f.alice.access), errorCode('UNAUTHORIZED'));
  });
}

test('sqlite: persisted snapshots, tombstones, history, replay and backup survive reopen', async t => {
  const f = await fixture(t, 'sqlite'), store = f.store as SqliteStore, value = entry(), mutation = put(value);
  const original = (await f.mutate(mutation)).json(); await f.mutate({ mutationId: randomUUID(), operation: 'delete', id: value.id, expectedVersion: 1 });
  const expected = await f.snapshot(), history = await f.history(); const backup = join(f.directory!, 'backup.sqlite'); await store.backupTo(backup);
  await store.close();
  for (const path of [store.path, backup]) {
    const opened = new SqliteStore(path); f.stores.push(opened);
    assert.equal(opened.db.prepare('PRAGMA user_version').get()!.user_version, 4);
    assert.deepEqual(await opened.getPreferences(f.alice.access), expected);
    assert.deepEqual(await opened.getPreferenceHistory(f.alice.access, { limit: 50 }), history);
    assert.deepEqual(await opened.mutatePreferences(f.alice.access, mutation), original);
  }
});

test('sqlite: audit failure rolls back snapshot, history and idempotency receipt atomically', async t => {
  const f = await fixture(t, 'sqlite'), store = f.store as SqliteStore, mutation = put();
  store.db.exec("CREATE TRIGGER preference_audit_failure BEFORE INSERT ON rufa_audit WHEN NEW.action LIKE 'preferences.%' BEGIN SELECT RAISE(ABORT,'test'); END;");
  const failure = await f.mutate(mutation); assert.equal(failure.statusCode, 500); assert.ok(!failure.body.includes('test'));
  assert.deepEqual(await f.snapshot(), emptyPreferences()); assert.deepEqual(await f.history(), { history: [] });
  store.db.exec('DROP TRIGGER preference_audit_failure');
  assert.equal((await f.mutate(mutation)).json().snapshot.revision, 1);
});
