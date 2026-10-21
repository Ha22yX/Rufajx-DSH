import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import { buildApp } from '../src/app.js';
import { configFromEnv } from '../src/config.js';
import { parseAdminSessionQuery, type AdminOverview, type AdminSessionPage } from '../src/admin-queries.js';
import { makeToken, tokenHash } from '../src/security.js';
import { SqliteStore } from '../src/sqlite-store.js';
import { PostgresStore } from '../src/postgres-store.js';
import type { Store } from '../src/store.js';
import type { Login, SessionSummary, StoredEvent, Usage, User } from '../src/types.js';
import { MemoryStore } from './memory-store.js';

const now = '2026-10-21T12:00:00.000Z', from = '2026-10-20T00:00:00.000Z', to = '2026-10-21T00:00:00.000Z';
const passwordHash = 'synthetic-password-hash-never-a-real-credential', upstreamKey = 'synthetic-upstream-key-never-used';
const sessionUrl = '/api/v1/admin/sessions', overviewUrl = '/api/v1/admin/overview';
type Backend = 'sqlite' | 'memory';

async function fixture(t: TestContext, backend: Backend = 'sqlite') {
  const directory = backend === 'sqlite' ? await mkdtemp(join(tmpdir(), 'rufa-admin-queries-')) : undefined;
  const store = directory ? new SqliteStore(join(directory, 'company.sqlite')) : new MemoryStore();
  const app = buildApp(store, { ...configFromEnv({}), now: () => Date.parse(now), upstreamKey });
  const reopened: Store[] = [];
  t.after(async () => {
    await app.close(); await store.close(); for (const other of reopened) await other.close();
    if (directory) {
      assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('rufa-admin-queries-'));
      await rm(directory, { recursive: true, force: true });
    }
  });
  const user = (username: string, role: 'admin' | 'employee' = 'employee') => store.createUser({ username, displayName: username, role, passwordHash });
  const admin = await user('manager', 'admin'), employee = await user('employee'), other = await user('other');
  const login = async (user: User) => {
    const accessToken = makeToken();
    const value: Login = { id: randomUUID(), userId: user.id, deviceId: randomUUID(), deviceLabel: 'synthetic-device', accessHash: tokenHash(accessToken), refreshHash: tokenHash(makeToken()), accessExpiresAt: '2026-10-22T12:00:00.000Z', refreshExpiresAt: '2026-10-24T12:00:00.000Z', revokedAt: null, createdAt: now };
    await store.createLogin(value, passwordHash);
    return { ...value, accessToken };
  };
  const adminLogin = await login(admin), employeeLogin = await login(employee);
  const get = (path: string, query: Record<string, string> = {}, token = adminLogin.accessToken) => app.inject({ method: 'GET', url: `${path}${Object.keys(query).length ? `?${new URLSearchParams(query)}` : ''}`, headers: token ? { authorization: `Bearer ${token}` } : {} });
  const session = async (ownerId: string, id: string, updatedAt: string, title = 'synthetic session') => {
    await store.createSession(ownerId, { id, title });
    if (store instanceof SqliteStore) store.db.prepare('UPDATE rufa_sessions SET updated_at=? WHERE id=?').run(updatedAt, id);
    else store.sessions.get(id)!.updatedAt = updatedAt;
    return (await store.getSession(id))!;
  };
  const patchUser = (id: string, patch: Partial<User>) => {
    if (store instanceof MemoryStore) Object.assign(store.users.get(id)!, patch);
    else for (const [field, value] of Object.entries(patch)) {
      const columns: Record<string, string> = { status: 'status', purgedAt: 'purged_at', purgeAfter: 'purge_after', deletedAt: 'deleted_at' };
      assert.ok(columns[field]); store.db.prepare(`UPDATE rufa_users SET ${columns[field]}=? WHERE id=?`).run(value ?? null, id);
    }
  };
  const usage = async (userId: string, loginId: string, createdAt: string, status: Usage['status'], inputTokens: number | null, outputTokens: number | null, totalTokens: number | null) => {
    await store.recordUsage({ id: randomUUID(), userId, loginId, requestId: randomUUID(), model: 'synthetic', createdAt, status, inputTokens, outputTokens, totalTokens });
  };
  const audits = () => store instanceof MemoryStore ? store.audits : store.db.prepare('SELECT * FROM rufa_audit').all();
  await app.ready();
  return { store, app, directory, reopened, user, admin, employee, other, adminLogin, employeeLogin, login, get, session, patchUser, usage, audits };
}

for (const backend of ['sqlite', 'memory'] as const) {
  test(`${backend}: new admin reads reject employees, missing credentials, disabled and revoked callers`, async t => {
    const f = await fixture(t, backend);
    for (const path of [sessionUrl, overviewUrl]) {
      assert.equal((await f.get(path, {}, '')).statusCode, 401);
      assert.equal((await f.get(path, {}, f.employeeLogin.accessToken)).statusCode, 403);
      const response = await f.get(path); assert.equal(response.statusCode, 200, response.body);
      for (const secret of [passwordHash, upstreamKey, f.adminLogin.accessToken, f.adminLogin.accessHash, f.adminLogin.refreshHash]) assert.ok(!response.body.includes(secret));
    }
    await f.user('second-manager', 'admin');
    await f.store.updateUser(f.admin.id, { status: 'disabled' });
    for (const path of [sessionUrl, overviewUrl]) assert.equal((await f.get(path)).statusCode, 401);
    await f.store.updateUser(f.admin.id, { status: 'active' });
    for (const path of [sessionUrl, overviewUrl]) assert.equal((await f.get(path)).statusCode, 401, 'reactivation does not revive revoked login');
    const access = await f.login(f.admin); await f.store.revokeLogin(access.id);
    for (const path of [sessionUrl, overviewUrl]) assert.equal((await f.get(path, {}, access.accessToken)).statusCode, 401);
    const actions = f.audits().filter(row => row.action === 'admin.sessions.query' || row.action === 'admin.overview.read');
    assert.equal(actions.length, 2);
  });

  test(`${backend}: filtered keyset traverses more than 100 sessions with equal timestamps and stable totals`, async t => {
    const f = await fixture(t, backend), expected: SessionSummary[] = [];
    for (let i = 0; i < 123; i++) expected.push(await f.session(i % 2 ? f.other.id : f.employee.id, `history-${String(i).padStart(3, '0')}`, i < 80 ? from : '2026-10-20T16:00:00.000Z', '检索 ABC'));
    await f.session(f.employee.id, 'excluded-before', '2026-10-19T23:59:59.999Z');
    await f.session(f.employee.id, 'excluded-at-end', to);
    expected.sort((a, b) => a.updatedAt === b.updatedAt ? (a.id > b.id ? -1 : 1) : a.updatedAt > b.updatedAt ? -1 : 1);
    const ids: string[] = []; let cursor: string | undefined, firstCursor: string | undefined;
    do {
      const response = await f.get(sessionUrl, { from, to, q: 'abc', ...(cursor ? { cursor } : {}) });
      assert.equal(response.statusCode, 200, response.body);
      const page = response.json<AdminSessionPage>(); assert.equal(page.total, 123); assert.ok(page.sessions.length <= 50);
      ids.push(...page.sessions.map(row => row.id)); cursor = page.nextCursor; firstCursor ??= cursor;
    } while (cursor);
    assert.deepEqual(ids, expected.map(row => row.id)); assert.equal(new Set(ids).size, 123);
    const own = await f.get(sessionUrl, { from, to, ownerId: f.employee.id, limit: '1000' });
    assert.equal(own.json().total, 62); assert.equal(own.json().sessions.length, 62);
    assert.equal((await f.get(sessionUrl, { ownerId: randomUUID() })).json().total, 0);
    assert.equal((await f.get(sessionUrl, { from, to, q: 'different', cursor: firstCursor! })).statusCode, 400);
    assert.equal((await f.get(sessionUrl, { from, to, q: 'abc', ownerId: f.employee.id, cursor: firstCursor! })).statusCode, 400);
    const changedLimit = await f.get(sessionUrl, { from, to, q: 'abc', cursor: firstCursor!, limit: '1' });
    assert.equal(changedLimit.statusCode, 200); assert.equal(changedLimit.json().sessions[0].id, expected[50].id);
    const legacy = await f.get(`/api/v1/admin/users/${f.employee.id}/sessions`, { limit: '1000' });
    assert.equal(legacy.statusCode, 200); assert.equal(legacy.json().sessions.length, 64); assert.equal(legacy.json().total, undefined);
  });

  test(`${backend}: native events remain complete over pages; search finds long tail and literal SQL/JSON punctuation`, async t => {
    const f = await fixture(t, backend), id = 'full-native-log';
    const header = { version: 4, id, createdAt: Date.parse(from), cwd: 'C:\\SyntheticOnly', isSeeded: false };
    await f.store.createSession(f.employee.id, { id, title: 'native fixture', upstreamHeader: header, inheritedEventCount: 0 });
    await f.session(f.other.id, 'unrelated', from, 'all punctuation wildcard decoy');
    const access = { userId: f.employee.id, loginId: f.employeeLogin.id, accessHash: f.employeeLogin.accessHash, now: () => now };
    const lease = await f.store.acquireLease(id, access, 60000);
    const events: StoredEvent[] = Array.from({ length: 1207 }, (_, seq) => ({ seq, event: { seq, time: Date.parse(from) + seq, type: 'user/message', data: { id: `message-${seq}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `原生消息${seq}` }] } } }));
    events[0].event = { seq: 0, time: Date.parse(from), type: 'user/message', data: { id: 'user-0', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '请分析附件' }, { type: 'file', attachment: { id: 'synthetic-file', filename: '报价.xlsx', size: 123, path: 'C:\\SyntheticOnly\\报价.xlsx' } }] } };
    events[1].event = { seq: 1, time: Date.parse(from) + 1, type: 'assistant/message', data: { turn: 0, step: 0, message: { id: 'assistant-1', role: 'assistant', source: { kind: 'model', provider: 'company', model: 'synthetic' }, content: [{ type: 'reasoning', text: '原样保留思考' }, { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"path":"报价.xlsx"}' }] }, stream: [] } };
    const needles = ['LONGTAIL_FINAL_MARKER', '100%_! literal', 'C:\\SyntheticOnly\\file.txt', 'quote"inside', "%' OR 1=1 --", '换行\n内容', '末尾🙂'];
    events[1206].event = { seq: 1206, time: Date.parse(from) + 1206, type: 'tool/result', data: { turn: 0, step: 0, message: { id: 'result-1', role: 'tool', source: { kind: 'tool', callId: 'call-1' }, toolCallId: 'call-1', isError: false, content: [{ type: 'text', text: 'x'.repeat(180000) + needles.join(' | ') }] }, meta: { complete: ['原始元数据', { extension: true }] } } };
    for (let start = 0; start < events.length; start += 1000) await f.store.appendEvents(id, access, lease.leaseId, start, events.slice(start, start + 1000));
    for (const q of needles) {
      const response = await f.get(sessionUrl, { q }); assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json().sessions.map((row: SessionSummary) => row.id), [id]); assert.equal(response.json().total, 1);
    }
    const matches = await f.get(sessionUrl, { q: 'LONGTAIL_FINAL_MARKER' });
    assert.deepEqual(matches.json().sessions[0].upstreamHeader, header); assert.equal(matches.json().sessions[0].nextSeq, 1207);
    const read: StoredEvent[] = []; let afterSeq = -1;
    while (read.length < events.length) {
      const response = await f.get(`${sessionUrl}/${id}/events`, { afterSeq: String(afterSeq), limit: '200' });
      assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().nextSeq, 1207);
      const page = response.json().events as StoredEvent[]; assert.ok(page.length); assert.equal(page[0].seq, afterSeq + 1);
      read.push(...page); afterSeq = page.at(-1)!.seq;
    }
    assert.deepEqual(read, events);
    const auditText = JSON.stringify(f.audits());
    for (const secret of [...needles, passwordHash, upstreamKey, f.adminLogin.accessToken, f.employeeLogin.accessHash]) assert.ok(!auditText.includes(secret));
    assert.equal((await f.store.getSession(id))!.nextSeq, events.length);
  });

  test(`${backend}: overview counts lifecycle states, zero usage and partial recorded tokens without deriving totals`, async t => {
    const f = await fixture(t, backend);
    const disabled = await f.user('disabled'), recycled = await f.user('recycled'), archived = await f.user('archived'), expired = await f.user('expired');
    f.patchUser(disabled.id, { status: 'disabled' });
    f.patchUser(recycled.id, { status: 'deleted', deletedAt: from, purgeAfter: '2026-10-27T00:00:00.000Z' });
    f.patchUser(archived.id, { status: 'deleted', deletedAt: from, purgeAfter: to, purgedAt: now });
    f.patchUser(expired.id, { status: 'deleted', deletedAt: from, purgeAfter: now });
    await f.session(f.employee.id, 'one', from); await f.session(f.employee.id, 'two', to); await f.session(archived.id, 'three', from);
    await f.usage(f.employee.id, f.employeeLogin.id, '2026-10-19T23:59:59.999Z', 'completed', 100, 100, 200);
    await f.usage(f.employee.id, f.employeeLogin.id, from, 'completed', 10, 20, 30);
    await f.usage(f.employee.id, f.employeeLogin.id, '2026-10-20T11:00:00.000Z', 'failed', null, 5, null);
    await f.usage(f.admin.id, f.adminLogin.id, '2026-10-20T12:00:00.000Z', 'cancelled', 7, null, 9);
    await f.usage(f.admin.id, f.adminLogin.id, '2026-10-20T13:00:00.000Z', 'completed', 0, 0, 0);
    await f.usage(f.admin.id, f.adminLogin.id, to, 'failed', null, null, null);
    const response = await f.get(overviewUrl, { from, to }); assert.equal(response.statusCode, 200, response.body);
    const value = response.json<AdminOverview>();
    assert.deepEqual(value.accounts, { total: 7, active: 3, disabled: 1, recycled: 1, archived: 2 });
    assert.deepEqual(value.sessions, { total: 3, updatedInRange: 2 });
    assert.deepEqual(value.usage, { requests: 4, completed: 2, failed: 1, cancelled: 1, inputTokens: 17, outputTokens: 25, totalTokens: 39, missingUsageRequests: 2 });
    assert.equal(value.users.length, 7);
    assert.deepEqual(value.users.find(row => row.userId === f.employee.id), { userId: f.employee.id, sessions: 2, requests: 2, inputTokens: 10, outputTokens: 25, totalTokens: 30, missingUsageRequests: 1 });
    assert.equal(value.users.find(row => row.userId === archived.id)!.sessions, 1);
    assert.equal(value.users.find(row => row.userId === f.other.id)!.requests, 0);
    const empty = (await f.get(overviewUrl, { from: '2025-01-01T00:00:00Z', to: '2025-01-02T00:00:00Z' })).json<AdminOverview>();
    assert.equal(empty.accounts.total, 7); assert.equal(empty.sessions.total, 3); assert.equal(empty.sessions.updatedInRange, 0);
    assert.equal(empty.usage.requests, 0); assert.equal(empty.usage.totalTokens, 0); assert.equal(empty.users.find(row => row.userId === f.employee.id)!.sessions, 2);
    const all = (await f.get(overviewUrl)).json<AdminOverview>(); assert.equal(all.usage.requests, 6); assert.equal(all.usage.missingUsageRequests, 3);
    assert.equal((await f.store.findUser('expired'))!.purgedAt, null, 'read-only overview must not purge accounts');
  });
}

test('SQLite rejects malformed query inputs without logging their contents or broadening the filter', async t => {
  const f = await fixture(t);
  const invalidQueries: Record<string, string>[] = [{ q: 'x'.repeat(201) }, { q: '\0' }, { ownerId: 'anything' }, { from: '2026-02-30T00:00:00Z' }, { from: '2026-01-01' }, { to: '2026-01-01T24:00:00Z' }, { from: to, to: from }, { from, to: from }, { from: '2026-01-01T00:00:00+24:00' }, { limit: '0' }, { limit: '1001' }, { limit: '1.2' }, { cursor: 'undefined' }, { cursor: 'x'.repeat(1025) }, { arbitrary: 'field' }];
  for (const query of invalidQueries) { const response = await f.get(sessionUrl, query); assert.equal(response.statusCode, 400, JSON.stringify(query)); assert.ok(!response.body.includes(passwordHash)); }
  const badRanges: Record<string, string>[] = [{ from: '2026-02-30T00:00:00Z' }, { from, to: from }, { ownerId: f.employee.id }];
  for (const query of badRanges) assert.equal((await f.get(overviewUrl, query)).statusCode, 400);
  assert.equal((await f.get(`${sessionUrl}?q=first&q=second`)).statusCode, 400);
  assert.equal((await f.get(`${overviewUrl}?from=${encodeURIComponent(from)}&from=${encodeURIComponent(to)}`)).statusCode, 400);
  await f.session(f.employee.id, 'offset-from', from);
  const offset = await f.get(sessionUrl, { from: '2026-10-19T20:00:00-04:00', to: '2026-10-20T20:00:00-04:00', q: '   ' });
  assert.equal(offset.statusCode, 200); assert.equal(offset.json().total, 1);
});

test('SQLite admin results are refused if authorization changes during the query', async t => {
  const f = await fixture(t); await f.user('backup-admin', 'admin');
  const originalQuery = f.store.queryAdminSessions.bind(f.store);
  f.store.queryAdminSessions = async query => { const result = await originalQuery(query); await f.store.updateUser(f.admin.id, { role: 'employee' }); return result; };
  assert.equal((await f.get(sessionUrl)).statusCode, 401, 'role change revokes the login');
  await f.store.updateUser(f.admin.id, { role: 'admin' });
  const fresh = await f.login(f.admin);
  const originalOverview = f.store.getAdminOverview.bind(f.store);
  f.store.getAdminOverview = async (range, time) => { const result = await originalOverview(range, time); await f.store.revokeLogin(fresh.id); return result; };
  assert.equal((await f.get(overviewUrl, {}, fresh.accessToken)).statusCode, 401);
});

test('SQLite additive indexes preserve stored event bytes, digest, schema and accounts on reopen', async t => {
  const f = await fixture(t); assert.ok(f.store instanceof SqliteStore);
  await f.session(f.employee.id, 'persisted-history', from);
  const raw = '{ "type": "user/message", "data": { "content": [{ "type": "text", "text": "精确保留" }] } }';
  f.store.db.prepare('INSERT INTO rufa_session_events(session_id,seq,event,digest) VALUES(?,?,?,?)').run('persisted-history', 0, raw, 'unchanged-old-digest');
  for (const name of ['rufa_sessions_updated_idx', 'rufa_sessions_owner_updated_idx', 'rufa_usage_created_user_idx']) f.store.db.exec(`DROP INDEX ${name}`);
  const reopened = new SqliteStore(f.store.path); f.reopened.push(reopened);
  const saved = reopened.db.prepare('SELECT event,digest FROM rufa_session_events WHERE session_id=?').get('persisted-history')!;
  assert.equal(saved.event, raw); assert.equal(saved.digest, 'unchanged-old-digest'); assert.equal(reopened.db.prepare('PRAGMA user_version').get()!.user_version, 4);
  assert.equal((await reopened.findUser('employee'))!.passwordHash, passwordHash);
  for (const name of ['rufa_sessions_updated_idx', 'rufa_sessions_owner_updated_idx', 'rufa_usage_created_user_idx']) assert.ok(reopened.db.prepare('SELECT 1 FROM sqlite_master WHERE type=\'index\' AND name=?').get(name));
  assert.equal((await reopened.queryAdminSessions(parseAdminSessionQuery({ q: '精确保留' }))).total, 1);
});

test('SQLite count and rows, then overview aggregates use coherent snapshots during real concurrent commits', async t => {
  const f = await fixture(t); assert.ok(f.store instanceof SqliteStore);
  const first = await f.session(f.employee.id, 'first', from);
  const other = new SqliteStore(f.store.path); f.reopened.push(other);
  const prepare = f.store.db.prepare.bind(f.store.db);
  let inserted: Promise<SessionSummary> | undefined, interleaved = false;
  f.store.db.prepare = sql => {
    const statement = prepare(sql);
    if (sql.startsWith('SELECT count(*) AS total FROM rufa_sessions') && !interleaved) {
      const get = statement.get.bind(statement);
      statement.get = (...args) => { const result = Reflect.apply(get, statement, args); interleaved = true; inserted = other.createSession(f.other.id, { id: 'concurrent' }); return result; };
    }
    return statement;
  };
  let page: AdminSessionPage;
  try { page = await f.store.queryAdminSessions(parseAdminSessionQuery({})); } finally { f.store.db.prepare = prepare; }
  await inserted; assert.equal(page.total, 1); assert.deepEqual(page.sessions, [first]);
  assert.equal((await f.store.queryAdminSessions(parseAdminSessionQuery({}))).total, 2);

  let recorded: Promise<void> | undefined; interleaved = false;
  f.store.db.prepare = sql => {
    const statement = prepare(sql);
    if (sql.includes(' AS archived FROM rufa_users') && !interleaved) {
      const get = statement.get.bind(statement);
      statement.get = (...args) => { const result = Reflect.apply(get, statement, args); interleaved = true; recorded = other.recordUsage({ id: randomUUID(), userId: f.employee.id, loginId: f.employeeLogin.id, model: 'synthetic', requestId: randomUUID(), status: 'completed', createdAt: from, inputTokens: 2, outputTokens: 3, totalTokens: 5 }); return result; };
    }
    return statement;
  };
  let overview: AdminOverview;
  try { overview = await f.store.getAdminOverview({}, now); } finally { f.store.db.prepare = prepare; }
  await recorded; assert.equal(overview.usage.requests, 0); assert.equal(overview.users.find(row => row.userId === f.employee.id)!.requests, 0);
  assert.equal((await f.store.getAdminOverview({}, now)).usage.requests, 1);
});

// SQL/transaction compatibility checks only; these are not a real PostgreSQL run.
test('PostgreSQL admin page binds filters, keeps count/page in one snapshot and preserves microsecond cursor', async () => {
  const calls: { sql: string; values?: any[] }[] = []; let released = false;
  const timestamp = '2026-10-20T12:00:00.123456Z';
  const client = { async query(sql: string, values?: any[]) {
    calls.push({ sql, values });
    if (sql.startsWith('SELECT count(*)')) return { rows: [{ total: '2' }] };
    if (sql.startsWith('SELECT s.*')) return { rows: ['b', 'a'].map(id => ({ id, owner_id: randomUUID(), title: 'title', created_at: timestamp, updated_at: timestamp, next_seq: '0', inherited_event_count: '0', upstream_header: null, workspace_ref: null, cursor_time: timestamp })) };
    return { rows: [] };
  }, release() { released = true; } };
  const store = new PostgresStore({ connect: async () => client, query() { throw new Error('escaped snapshot'); } } as unknown as Pool);
  const query = { from, to, q: "%' OR 1=1 --", limit: '1' };
  const page = await store.queryAdminSessions(parseAdminSessionQuery(query));
  assert.equal(page.total, 2); assert.equal(page.sessions.length, 1);
  const next = parseAdminSessionQuery({ ...query, cursor: page.nextCursor }); assert.equal(next.cursor!.updatedAt, timestamp);
  assert.equal(calls[0].sql, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); assert.equal(calls.at(-1)!.sql, 'COMMIT'); assert.ok(released);
  assert.ok(calls[1].values!.some(value => value === "%!%' OR 1=1 --%")); assert.ok(!calls[1].sql.includes(query.q));
  await store.queryAdminSessions(next);
  assert.ok(calls.some(call => call.values?.includes(timestamp))); assert.ok(calls.some(call => call.sql.includes('COLLATE "C"')));
});

test('PostgreSQL overview uses one read-only snapshot and converts aggregate strings without inventing totals', async () => {
  const calls: { sql: string; values?: any[] }[] = []; let released = false;
  const client = { async query(sql: string, values?: any[]) {
    calls.push({ sql, values });
    if (sql.includes(' AS archived FROM rufa_users')) return { rows: [{ total: '3', active: '1', disabled: '0', archived: '1' }] };
    if (sql.includes(' AS updated FROM rufa_sessions')) return { rows: [{ total: '4', updated: '2' }] };
    if (sql.startsWith('SELECT user_id')) return { rows: [{ user_id: 'u', requests: '2', completed: '1', failed: '1', cancelled: '0', input_tokens: '12', output_tokens: '3', total_tokens: '10', missing: '1' }] };
    if (sql.startsWith('SELECT u.id')) return { rows: [{ user_id: 'u', sessions: '3' }, { user_id: 'v', sessions: '1' }, { user_id: 'w', sessions: '0' }] };
    return { rows: [] };
  }, release() { released = true; } };
  const store = new PostgresStore({ connect: async () => client, query() { throw new Error('escaped snapshot'); } } as unknown as Pool);
  const result = await store.getAdminOverview({ from, to }, now);
  assert.deepEqual(result.accounts, { total: 3, active: 1, disabled: 0, archived: 1, recycled: 1 });
  assert.equal(result.usage.totalTokens, 10); assert.equal(result.usage.missingUsageRequests, 1); assert.equal(result.users[1].requests, 0);
  assert.equal(calls[0].sql, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); assert.equal(calls.at(-1)!.sql, 'COMMIT'); assert.ok(released);
  assert.deepEqual(calls.find(row => row.sql.startsWith('SELECT user_id'))!.values, [from, to]);
});
