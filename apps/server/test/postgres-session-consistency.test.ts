// SQL/transaction contract tests only. These do not replace a real PostgreSQL run.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { PostgresStore } from '../src/postgres-store.js';
import { eventDigest } from '../src/security.js';
import { sessionEventDigest } from '../src/session-events.js';
import type { SessionAccess } from '../src/store.js';
import { AppError } from '../src/types.js';

const code = (name: string) => (error: unknown) => error instanceof AppError && error.code === name;
function fixture() {
  const calls: { sql: string; values?: any[] }[] = [];
  const state = {
    time: '2026-10-21T12:00:00.000Z', released: false,
    user: { id: 'user', status: 'active' },
    login: { id: 'login', user_id: 'user', access_hash: 'synthetic-hash', access_expires_at: '2026-10-21T13:00:00.000Z', revoked_at: null as string | null },
    session: { id: 'session', owner_id: 'user', next_seq: '0', title: 'old title', lease_id: 'lease', lease_login_id: 'login', lease_expires_at: '2026-10-21T12:00:30.000Z' },
    saved: [] as { digest: string; event: unknown }[], events: [] as { seq: string; event: unknown }[],
    beforeQuery: (_sql: string) => {},
  };
  const client = { async query(sql: string, values?: any[]) {
    calls.push({ sql, values }); state.beforeQuery(sql);
    if (sql.startsWith('SELECT * FROM rufa_users')) return { rows: [state.user] };
    if (sql.startsWith('SELECT * FROM rufa_logins')) return { rows: [state.login] };
    if (sql.startsWith('SELECT * FROM rufa_sessions')) return { rows: [state.session] };
    if (sql.startsWith('SELECT next_seq')) return { rows: [{ next_seq: state.session.next_seq }] };
    if (sql.startsWith('SELECT seq,event')) return { rows: state.events };
    if (sql.startsWith('SELECT digest,event')) return { rows: state.saved };
    return { rows: [], rowCount: 1 };
  }, release() { state.released = true; } };
  const pool = { async connect() { return client; }, query() { throw new Error('transaction escaped its client'); } } as unknown as Pool;
  const access: SessionAccess = { userId: 'user', loginId: 'login', accessHash: 'synthetic-hash', now() { calls.push({ sql: 'CLOCK' }); return state.time; } };
  return { state, calls, access, store: new PostgresStore(pool) };
}
const lockPrefix = ['BEGIN', 'SELECT * FROM rufa_users WHERE id=$1 FOR UPDATE', 'SELECT * FROM rufa_logins WHERE id=$1 FOR UPDATE', 'SELECT * FROM rufa_sessions WHERE id=$1 FOR UPDATE', 'CLOCK'];

test('PostgreSQL event page uses one repeatable read client snapshot and bounds events by its head', async () => {
  const f = fixture(); f.state.session.next_seq = '2'; f.state.events = [{ seq: '1', event: { type: 'tool/result' } }];
  assert.deepEqual(await f.store.readEventPage('session', 0, 1), { nextSeq: 2, events: [{ seq: 1, event: { type: 'tool/result' } }] });
  assert.equal(f.calls[0].sql, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.deepEqual(f.calls[2].values, ['session', 0, 2, 1]); assert.match(f.calls[2].sql, /seq<\$3/);
  assert.equal(f.calls.at(-1)!.sql, 'COMMIT'); assert.equal(f.state.released, true);
});

test('PostgreSQL lease creation samples clock after user/login/session locks and renews with a fresh token after expiry', async () => {
  const f = fixture(); f.state.beforeQuery = sql => { if (sql === lockPrefix[3]) f.state.time = '2026-10-21T12:00:31.000Z'; };
  const lease = await f.store.acquireLease('session', f.access, 60_000);
  assert.deepEqual(f.calls.slice(0, 5).map(row => row.sql), lockPrefix);
  assert.notEqual(lease.leaseId, 'lease'); assert.equal(lease.expiresAt, '2026-10-21T12:01:31.000Z');
  assert.deepEqual(f.calls[5].values, ['session', lease.leaseId, 'login', lease.expiresAt]); assert.equal(f.state.released, true);
});

for (const expiry of ['lease', 'access'] as const) test(`PostgreSQL append rejects ${expiry} expiry after waiting for the last lock`, async () => {
  const f = fixture();
  f.state.beforeQuery = sql => { if (sql === lockPrefix[3]) f.state.time = expiry === 'lease' ? '2026-10-21T12:00:31.000Z' : '2026-10-21T13:00:01.000Z'; };
  await assert.rejects(f.store.appendEvents('session', f.access, 'lease', 0, [{ seq: 0, event: { type: 'user/message' } }]), code(expiry === 'lease' ? 'LEASE_LOST' : 'UNAUTHORIZED'));
  assert.deepEqual(f.calls.map(row => row.sql), [...lockPrefix, 'ROLLBACK']); assert.equal(f.state.released, true);
});

for (const operation of ['acquire', 'append', 'release', 'replay'] as const) test(`PostgreSQL ${operation} revalidates login under locks before writes or idempotent success`, async () => {
  const f = fixture(); f.state.session.next_seq = operation === 'replay' ? '1' : '0';
  f.state.saved = [{ digest: sessionEventDigest({ type: 'user/message' }), event: { type: 'user/message' } }];
  f.state.beforeQuery = sql => { if (sql === lockPrefix[2]) f.state.login.revoked_at = f.state.time; };
  const result = operation === 'acquire' ? f.store.acquireLease('session', f.access, 60_000) : operation === 'release' ? f.store.releaseLease('session', f.access, 'lease') : f.store.appendEvents('session', f.access, 'lease', 0, [{ seq: 0, event: { type: 'user/message' } }]);
  await assert.rejects(result, code('UNAUTHORIZED')); assert.deepEqual(f.calls.map(row => row.sql), [...lockPrefix, 'ROLLBACK']);
  assert.equal(f.state.released, true);
});

test('PostgreSQL legacy JSONB digest fallback compares exact structured values without rewriting history', async () => {
  const f = fixture(), original = { type: 'tool/result', data: { 'é': 1, 'é': 2, order: [1, 2] } }, reordered = { data: { order: [1, 2], 'é': 2, 'é': 1 }, type: 'tool/result' };
  f.state.session.next_seq = '3'; f.state.saved = [{ digest: eventDigest(original), event: original }];
  assert.notEqual(eventDigest(original), eventDigest(reordered));
  assert.equal(await f.store.appendEvents('session', f.access, 'lease', 0, [{ seq: 0, event: reordered }]), 3);
  assert.ok(!f.calls.some(row => /^(INSERT|UPDATE)/.test(row.sql)));
  await assert.rejects(f.store.appendEvents('session', f.access, 'lease', 0, [{ seq: 0, event: { ...reordered, data: { ...reordered.data, order: [2, 1] } } }]), code('SEQUENCE_CONFLICT'));
  assert.equal(f.calls.at(-1)!.sql, 'ROLLBACK');
});

test('PostgreSQL append keeps event insert and head/title update in one transaction and rolls back later failures', async () => {
  const f = fixture(); f.state.beforeQuery = sql => { if (sql.startsWith('UPDATE rufa_sessions SET next_seq')) throw new Error('synthetic update failure'); };
  const event = { type: 'session/title', data: { title: 'new title' } };
  await assert.rejects(f.store.appendEvents('session', f.access, 'lease', 0, [{ seq: 0, event }]), /synthetic update failure/);
  assert.deepEqual(f.calls.slice(0, 5).map(row => row.sql), lockPrefix);
  assert.deepEqual(JSON.parse(f.calls[5].values![1]), [{ seq: 0, event, digest: sessionEventDigest(event) }]);
  assert.deepEqual(f.calls[6].values, ['session', 1, f.state.time, 'new title']);
  assert.equal(f.calls.at(-1)!.sql, 'ROLLBACK'); assert.equal(f.state.released, true);
});
