import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../src/app.js';
import { configFromEnv } from '../src/config.js';
import { eventDigest, makeToken, tokenHash } from '../src/security.js';
import { sessionEventDigest } from '../src/session-events.js';
import { SqliteStore } from '../src/sqlite-store.js';
import { AppError, type Login, type StoredEvent } from '../src/types.js';
import { sessionAccess } from './session-access.js';

const code = (name: string) => (error: unknown) => error instanceof AppError && error.code === name;
const batch: StoredEvent[] = [
  { seq: 0, event: { type: 'user/message', data: { text: 'synthetic task' } } },
  { seq: 1, event: { type: 'tool/result', data: { nested: [1, { original: true }], output: 'synthetic result' } } },
];
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'rufa-session-consistency-')), path = join(directory, 'company.sqlite');
  const stores: SqliteStore[] = [], apps: ReturnType<typeof buildApp>[] = [];
  const open = () => { const store = new SqliteStore(path); stores.push(store); return store; };
  const store = open(), user = await store.createUser({ username: 'synthetic', displayName: '测试', role: 'employee', passwordHash: 'synthetic-password-hash' });
  const accessToken = makeToken(), now = Date.now();
  const login: Login = { id: randomUUID(), userId: user.id, deviceId: randomUUID(), deviceLabel: 'synthetic', accessHash: tokenHash(accessToken), refreshHash: tokenHash(makeToken()),
    accessExpiresAt: new Date(now + 60_000).toISOString(), refreshExpiresAt: new Date(now + 120_000).toISOString(), revokedAt: null, createdAt: new Date(now).toISOString() };
  await store.createLogin(login, user.passwordHash);
  const session = await store.createSession(user.id, { id: randomUUID() }), access = sessionAccess(login);
  const lease = await store.acquireLease(session.id, access, 60_000);
  const build = (current = store, clock = Date.now) => { const app = buildApp(current, { ...configFromEnv({}), now: clock, leaseTtlMs: 2000 }); apps.push(app); return app; };
  const app = build(), headers = { authorization: `Bearer ${accessToken}` }, url = `/api/v1/sessions/${session.id}`;
  const append = (events = batch, expectedNextSeq = events[0].seq, current = app) => current.inject({ method: 'POST', url: `${url}/events`, headers, payload: { leaseId: lease.leaseId, expectedNextSeq, events } });
  t.after(async () => {
    for (const app of apps) await app.close();
    for (const store of stores) await store.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('rufa-session-consistency-'));
    await rm(directory, { recursive: true, force: true });
  });
  return { path, store, user, login, session, access, lease, app, headers, url, append, open, build };
}

async function worker(t: TestContext, path: string) {
  const child = fork(fileURLToPath(new URL('./session-consistency-worker.ts', import.meta.url)), [path], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr?.on('data', value => { stderr += value; });
  const exited = new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  const message = () => new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(new Error(`worker timeout: ${stderr}`)); }, 10_000);
    const receive = (value: unknown) => { cleanup(); resolve(value); };
    const exit = () => { cleanup(); reject(new Error(`worker exited before message: ${stderr}`)); };
    function cleanup() { clearTimeout(timeout); child.off('message', receive); child.off('exit', exit); }
    child.once('message', receive); child.once('exit', exit);
  });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited; });
  assert.equal((await message()).status, 'ready');
  return { child, exited, message };
}

test('SQLite HTTP lost ACK after commit survives restart and exact/subset retries return current head once', async t => {
  const f = await fixture(t); let dropped = false;
  f.app.addHook('onSend', async (req, reply) => {
    if (!dropped && req.method === 'POST' && req.url === `${f.url}/events` && reply.statusCode === 200) { dropped = true; reply.raw.socket?.destroy(); }
  });
  const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
  await assert.rejects(new Promise<void>((resolve, reject) => {
    const body = JSON.stringify({ leaseId: f.lease.leaseId, expectedNextSeq: 0, events: batch });
    const req = request(`${address}${f.url}/events`, { method: 'POST', agent: false, headers: { ...f.headers, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => { res.resume(); res.on('end', resolve); });
    req.on('error', reject); req.end(body);
  }), (error: any) => error.code === 'ECONNRESET');
  assert.equal(dropped, true); await f.app.close(); await f.store.close();
  const reopened = f.open(), app = f.build(reopened);
  for (const events of [batch, batch.slice(0, 1)]) {
    const response = await f.append(events, 0, app); assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().nextSeq, 2);
  }
  assert.deepEqual(await reopened.readEventPage(f.session.id, -1, 10), { nextSeq: 2, events: batch });
});

test('SQLite HTTP partial overlap never rewrites a committed prefix and only a verified suffix advances head', async t => {
  const f = await fixture(t); assert.equal((await f.append()).statusCode, 200);
  const tail: StoredEvent = { seq: 2, event: { type: 'session/title', data: { title: 'new title' } } };
  const conflict = await f.append([batch[1], tail]); assert.equal(conflict.statusCode, 409); assert.equal(conflict.json().error.code, 'SEQUENCE_CONFLICT');
  assert.deepEqual(await f.store.readEventPage(f.session.id, -1, 10), { nextSeq: 2, events: batch });
  assert.equal((await f.append([tail])).json().nextSeq, 3);
  assert.equal((await f.append()).json().nextSeq, 3);
  assert.equal((await f.store.getSession(f.session.id))!.title, 'new title');
});

test('SQLite HTTP event page pins head and records to one WAL read transaction while another connection commits', async t => {
  const f = await fixture(t), other = f.open();
  await f.store.appendEvents(f.session.id, f.access, f.lease.leaseId, 0, batch.slice(0, 1));
  const prepare = f.store.db.prepare.bind(f.store.db), execute = f.store.db.exec.bind(f.store.db), transactions: string[] = [];
  let interleaved: Promise<number> | undefined;
  f.store.db.exec = sql => { transactions.push(sql); execute(sql); };
  f.store.db.prepare = sql => {
    const statement = prepare(sql);
    if (sql === 'SELECT next_seq FROM rufa_sessions WHERE id=?') {
      const get = statement.get.bind(statement);
      statement.get = (...args) => {
        const head = Reflect.apply(get, statement, args); assert.equal(transactions.at(-1), 'BEGIN');
        interleaved = other.appendEvents(f.session.id, f.access, f.lease.leaseId, 1, batch.slice(1)); return head;
      };
    }
    return statement;
  };
  await f.app.ready(); transactions.length = 0;
  const response = await f.app.inject({ url: `${f.url}/events`, headers: f.headers });
  f.store.db.prepare = prepare; f.store.db.exec = execute;
  assert.equal(response.statusCode, 200, response.body); assert.deepEqual(response.json(), { nextSeq: 1, events: batch.slice(0, 1) });
  assert.equal(await interleaved, 2); assert.deepEqual(transactions, ['BEGIN', 'COMMIT']);
  assert.deepEqual(await f.store.readEventPage(f.session.id, 0, 10), { nextSeq: 2, events: batch.slice(1) });
});

for (const operation of ['acquire', 'append', 'replay', 'release'] as const) for (const mutation of ['revoke', 'disable', 'rotate'] as const) {
  test(`SQLite HTTP ${operation} rechecks ${mutation} after route authentication, including idempotent return`, async t => {
    const f = await fixture(t), other = f.open();
    if (operation === 'replay') assert.equal((await f.append()).statusCode, 200);
    const before = f.store.db.prepare('SELECT * FROM rufa_sessions WHERE id=?').get(f.session.id);
    const mutate = async () => {
      if (mutation === 'revoke') await other.revokeLogin(f.login.id);
      else if (mutation === 'disable') await other.updateUser(f.user.id, { status: 'disabled' });
      else assert.ok(await other.rotateRefresh(f.login.refreshHash, { accessHash: tokenHash(makeToken()), refreshHash: tokenHash(makeToken()), accessExpiresAt: f.login.accessExpiresAt, refreshExpiresAt: f.login.refreshExpiresAt }, new Date().toISOString()));
    };
    if (operation === 'acquire') { const original = f.store.acquireLease.bind(f.store); f.store.acquireLease = async (...args) => { await mutate(); return original(...args); }; }
    else if (operation === 'release') { const original = f.store.releaseLease.bind(f.store); f.store.releaseLease = async (...args) => { await mutate(); return original(...args); }; }
    else { const original = f.store.appendEvents.bind(f.store); f.store.appendEvents = async (...args) => { await mutate(); return original(...args); }; }
    const response = operation === 'acquire' ? await f.app.inject({ method: 'POST', url: `${f.url}/lease`, headers: f.headers, payload: { deviceId: f.login.deviceId } }) : operation === 'release' ? await f.app.inject({ method: 'DELETE', url: `${f.url}/lease`, headers: f.headers, payload: { leaseId: f.lease.leaseId } }) : await f.append();
    assert.equal(response.statusCode, 401, response.body); assert.equal(response.json().error.code, 'UNAUTHORIZED');
    assert.deepEqual(f.store.db.prepare('SELECT * FROM rufa_sessions WHERE id=?').get(f.session.id), before);
    assert.deepEqual(await f.store.readEvents(f.session.id, -1, 10), operation === 'replay' ? batch : []);
  });
}

for (const expire of ['lease', 'access'] as const) test(`SQLite HTTP append rejects ${expire} expiring during a real cross-process write-lock wait`, async t => {
  const f = await fixture(t); await f.app.ready(); const w = await worker(t, f.path), locked = w.message();
  w.child.send({ operation: 'hold', expire, sessionId: f.session.id, loginId: f.login.id });
  const signal = await locked; assert.equal(signal.status, 'locked');
  const response = await f.append();
  assert.equal(response.statusCode, expire === 'lease' ? 409 : 401, response.body);
  assert.equal(response.json().error.code, expire === 'lease' ? 'LEASE_LOST' : 'UNAUTHORIZED');
  assert.ok(Date.now() > Date.parse(signal.deadline)); assert.equal(await w.exited, 0);
  assert.deepEqual(await f.store.readEventPage(f.session.id, -1, 10), { nextSeq: 0, events: [] });
});

test('SQLite lease renewal samples expiry after waiting and replaces the expired fencing token', async t => {
  const f = await fixture(t); await f.app.ready(); const w = await worker(t, f.path), locked = w.message();
  w.child.send({ operation: 'hold', expire: 'lease', sessionId: f.session.id }); await locked;
  const response = await f.app.inject({ method: 'POST', url: `${f.url}/lease`, headers: f.headers, payload: { deviceId: f.login.deviceId } });
  assert.equal(response.statusCode, 200, response.body); const lease = response.json();
  assert.notEqual(lease.leaseId, f.lease.leaseId); assert.ok(Date.parse(lease.expiresAt) > Date.now() + 1500);
  assert.equal(await w.exited, 0);
  await assert.rejects(f.store.releaseLease(f.session.id, f.access, f.lease.leaseId), code('LEASE_LOST'));
  await assert.rejects(f.store.appendEvents(f.session.id, f.access, f.lease.leaseId, 0, batch), code('LEASE_LOST'));
  assert.equal(await f.store.appendEvents(f.session.id, f.access, lease.leaseId, 0, batch), 2);
});

test('SQLite session writes enforce owner identity and device takeover fences the old writer', async t => {
  const f = await fixture(t), other = f.open(), now = Date.now();
  const second: Login = { ...f.login, id: randomUUID(), deviceId: randomUUID(), accessHash: tokenHash(makeToken()), refreshHash: tokenHash(makeToken()) };
  await other.createLogin(second, f.user.passwordHash);
  await assert.rejects(other.acquireLease(f.session.id, sessionAccess(second), 60_000), code('LEASE_CONFLICT'));
  const renewed = await f.store.acquireLease(f.session.id, f.access, 60_000); assert.equal(renewed.leaseId, f.lease.leaseId);
  f.store.db.prepare('UPDATE rufa_sessions SET lease_expires_at=? WHERE id=?').run(new Date(now - 1).toISOString(), f.session.id);
  const takeover = await other.acquireLease(f.session.id, sessionAccess(second), 60_000); assert.notEqual(takeover.leaseId, f.lease.leaseId);
  await assert.rejects(f.store.appendEvents(f.session.id, f.access, f.lease.leaseId, 0, batch), code('LEASE_LOST'));
  await assert.rejects(f.store.releaseLease(f.session.id, f.access, f.lease.leaseId), code('LEASE_LOST'));
  assert.equal(await other.appendEvents(f.session.id, sessionAccess(second), takeover.leaseId, 0, batch), 2);
  const outsider = await other.createUser({ username: 'outsider', displayName: 'other', role: 'employee', passwordHash: f.user.passwordHash });
  const foreign: Login = { ...second, id: randomUUID(), userId: outsider.id, accessHash: tokenHash(makeToken()), refreshHash: tokenHash(makeToken()) }; await other.createLogin(foreign, outsider.passwordHash);
  await assert.rejects(other.acquireLease(f.session.id, sessionAccess(foreign), 60_000), code('NOT_FOUND'));
  await assert.rejects(other.appendEvents(f.session.id, { ...sessionAccess(foreign), userId: f.user.id }, takeover.leaseId, 0, batch), code('UNAUTHORIZED'));
});

for (const phase of ['before-commit', 'after-commit'] as const) test(`SQLite hard exit ${phase} preserves whole-batch/head atomicity and retry across reopen`, async t => {
  const f = await fixture(t), w = await worker(t, f.path);
  w.child.send({ operation: 'crash', phase, sessionId: f.session.id, access: { userId: f.user.id, loginId: f.login.id, accessHash: f.login.accessHash }, leaseId: f.lease.leaseId, events: batch });
  assert.equal(await w.exited, phase === 'before-commit' ? 73 : 74);
  await f.store.close(); const reopened = f.open(), count = phase === 'before-commit' ? 0 : 2;
  assert.deepEqual(await reopened.readEventPage(f.session.id, -1, 10), { nextSeq: count, events: batch.slice(0, count) });
  assert.equal(await reopened.appendEvents(f.session.id, f.access, f.lease.leaseId, 0, batch), 2);
  assert.deepEqual(await reopened.readEventPage(f.session.id, -1, 10), { nextSeq: 2, events: batch });
  assert.equal(reopened.db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
});

test('SQLite old digests/raw JSON survive reopen; Unicode key reorder retries succeed but actual values/array order remain exact', async t => {
  const f = await fixture(t);
  const original = { type: 'tool/result', data: { 'é': 1, 'é': 2, list: [1, 2], nested: { z: true, a: null } } };
  const reordered = { data: { nested: { a: null, z: true }, list: [1, 2], 'é': 2, 'é': 1 }, type: 'tool/result' };
  assert.notEqual(eventDigest(original), eventDigest(reordered), 'exercise the legacy locale-equal key collision');
  assert.equal(sessionEventDigest(original), sessionEventDigest(reordered));
  f.store.db.prepare('INSERT INTO rufa_session_events(session_id,seq,event,digest) VALUES(?,?,?,?)').run(f.session.id, 0, JSON.stringify(original), eventDigest(original));
  f.store.db.prepare('UPDATE rufa_sessions SET next_seq=1 WHERE id=?').run(f.session.id);
  const saved = f.store.db.prepare('SELECT event,digest FROM rufa_session_events WHERE session_id=?').get(f.session.id);
  await f.store.close(); const reopened = f.open(), app = f.build(reopened);
  assert.equal((await f.append([{ seq: 0, event: reordered }], 0, app)).json().nextSeq, 1);
  for (const event of [{ ...reordered, data: { ...reordered.data, 'é': 3 } }, { ...reordered, data: { ...reordered.data, list: [2, 1] } }, { ...reordered, data: { ...reordered.data, list: ['1', 2] } }]) {
    const response = await f.append([{ seq: 0, event }], 0, app); assert.equal(response.statusCode, 409, response.body);
  }
  assert.deepEqual(reopened.db.prepare('SELECT event,digest FROM rufa_session_events WHERE session_id=?').get(f.session.id), saved);
  assert.equal((await f.append([{ seq: 1, event: original }], 1, app)).json().nextSeq, 2);
  assert.equal((await f.append([{ seq: 1, event: reordered }], 1, app)).json().nextSeq, 2);
  assert.match(reopened.db.prepare('SELECT digest FROM rufa_session_events WHERE session_id=? AND seq=1').get(f.session.id)!.digest as string, /^v2:[a-f0-9]{64}$/);
});
