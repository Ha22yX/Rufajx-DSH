import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { test, type TestContext } from 'node:test';
import { buildApp } from '../src/app.js';
import { configFromEnv, type ServerConfig } from '../src/config.js';
import { hashPassword, tokenHash } from '../src/security.js';
import { MemoryStore } from './memory-store.js';
import { DeepSeekSettings } from '../src/deepseek-settings.js';

const password = 'test-employee-password-2026';
const passwordHash = await hashPassword(password);
async function fixture(t: TestContext, config: Partial<ServerConfig> = {}, settings?: DeepSeekSettings) {
  const store = new MemoryStore();
  const admin = await store.createUser({ username: 'admin', displayName: '管理', role: 'admin', passwordHash });
  const alice = await store.createUser({ username: 'alice', displayName: '员工甲', role: 'employee', passwordHash });
  const bob = await store.createUser({ username: 'bob', displayName: '员工乙', role: 'employee', passwordHash });
  const app = buildApp(store, { ...configFromEnv({}), ...config }, undefined, settings);
  t.after(() => app.close());
  const login = async (username: string) => {
    const result = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password, deviceLabel: '测试设备' } });
    assert.equal(result.statusCode, 200, result.body); return result.json();
  };
  const adminLogin = await login('admin'); const aliceLogin = await login('alice'); const bobLogin = await login('bob');
  return { store, app, admin, alice, bob, adminLogin, aliceLogin, bobLogin, login };
}
const headers = (login: { accessToken: string }) => ({ authorization: `Bearer ${login.accessToken}` });
async function upstream(t: TestContext, handler: (request: IncomingMessage, response: ServerResponse, body: Buffer) => void) {
  const server = createServer(async (request, response) => { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); handler(request, response, Buffer.concat(chunks)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

// Deliberately never send/end the declared body. A 429 must arrive without waiting
// for it, which an inject-only test with an already buffered payload cannot prove.
async function pendingRequest(t: TestContext, app: ReturnType<typeof buildApp>, address: string, path: string, token: string, contentType = 'application/json') {
  const incoming = new Promise<IncomingMessage>(resolve => app.server.once('request', raw => setImmediate(() => resolve(raw))));
  const request = httpRequest(`${address}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': contentType, 'content-length': 10000 } });
  request.setTimeout(3000, () => request.destroy(new Error('response was delayed waiting for an unfinished body')));
  const response = new Promise<{ status: number; body: any }>((resolve, reject) => {
    request.on('response', async value => {
      try { const chunks: Buffer[] = []; for await (const chunk of value) chunks.push(Buffer.from(chunk)); resolve({ status: value.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }); } catch (error) { reject(error); }
    });
    request.on('error', reject);
  });
  // Held requests are intentionally destroyed without a response.
  void response.catch(() => {});
  t.after(() => request.destroy());
  request.flushHeaders();
  const raw = await incoming;
  return { request, response, abort: async () => { if (raw.destroyed) { request.destroy(); return; } const closed = new Promise<void>(resolve => raw.once('close', () => resolve())); request.destroy(); await closed; } };
}

async function secretFixture(t: TestContext, fallback?: string) {
  const folder = await mkdtemp(join(tmpdir(), 'rufa-server-secrets-'));
  t.after(async () => { assert.ok(resolve(folder).startsWith(`${resolve(tmpdir())}${sep}`) && basename(folder).startsWith('rufa-server-secrets-')); await rm(folder, { recursive: true, force: true }); });
  const path = join(folder, 'secrets', 'deepseek.json');
  return { path, folder, settings: await DeepSeekSettings.open(path, fallback) };
}

test('login protects credentials, rejects forged role and requires active account', async t => {
  const f = await fixture(t);
  assert.equal(f.aliceLogin.user.role, 'employee');
  assert.ok(f.aliceLogin.deviceId); assert.notEqual(f.aliceLogin.accessToken, f.aliceLogin.refreshToken);
  assert.ok(!JSON.stringify(f.aliceLogin).includes('passwordHash'));
  const saved = [...f.store.logins.values()].find(value => value.userId === f.alice.id)!;
  assert.equal(saved.accessHash, tokenHash(f.aliceLogin.accessToken));
  assert.ok(!JSON.stringify(saved).includes(f.aliceLogin.accessToken));
  assert.equal((await f.app.inject({ method: 'GET', url: '/api/v1/admin/users', headers: headers(f.aliceLogin) })).statusCode, 403);
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/v1/admin/users', headers: headers(f.aliceLogin), payload: { role: 'admin', username: 'hacker', displayName: 'x', password } })).statusCode, 403);
  assert.equal((await f.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: 'Bearer made-up-token' } })).statusCode, 401);
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'alice', password: 'wrong', role: 'admin' } })).statusCode, 401);
  assert.ok(!JSON.stringify(f.store.audits).includes(password));
});

test('refresh rotates tokens, preserves device and revokes family on replay', async t => {
  const f = await fixture(t);
  const result = await f.app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: f.aliceLogin.refreshToken } });
  assert.equal(result.statusCode, 200); const next = result.json();
  assert.equal(next.deviceId, f.aliceLogin.deviceId);
  assert.equal((await f.app.inject({ url: '/api/v1/auth/me', headers: headers(f.aliceLogin) })).statusCode, 401);
  assert.equal((await f.app.inject({ url: '/api/v1/auth/me', headers: headers(next) })).statusCode, 200);
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: f.aliceLogin.refreshToken } })).statusCode, 401);
  assert.equal((await f.app.inject({ url: '/api/v1/auth/me', headers: headers(next) })).statusCode, 401);
});

test('admin lifecycle preserves last active admin and revokes disabled/deleted/reset users', async t => {
  const f = await fixture(t);
  for (const payload of [{ status: 'disabled' }, { role: 'employee' }]) assert.equal((await f.app.inject({ method: 'PATCH', url: `/api/v1/admin/users/${f.admin.id}`, headers: headers(f.adminLogin), payload })).statusCode, 409);
  assert.equal((await f.app.inject({ method: 'DELETE', url: `/api/v1/admin/users/${f.admin.id}`, headers: headers(f.adminLogin) })).statusCode, 400);
  const created = await f.app.inject({ method: 'POST', url: '/api/v1/admin/users', headers: headers(f.adminLogin), payload: { username: 'new-user', displayName: '新员工', password, role: 'employee' } });
  assert.equal(created.statusCode, 201); assert.ok(!created.body.includes('passwordHash'));
  assert.equal((await f.app.inject({ method: 'PATCH', url: `/api/v1/admin/users/${f.alice.id}`, headers: headers(f.adminLogin), payload: { status: 'disabled' } })).statusCode, 200);
  assert.equal((await f.app.inject({ url: '/api/v1/auth/me', headers: headers(f.aliceLogin) })).statusCode, 401);
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: f.aliceLogin.refreshToken } })).statusCode, 401);
  assert.equal((await f.app.inject({ method: 'POST', url: `/api/v1/admin/users/${f.bob.id}/reset-password`, headers: headers(f.adminLogin), payload: { password: 'new-password-2026-test' } })).statusCode, 204);
  assert.equal((await f.app.inject({ url: '/api/v1/auth/me', headers: headers(f.bobLogin) })).statusCode, 401);
  const session = await f.store.createSession(f.alice.id, { title: '保留的业务记录' });
  assert.equal((await f.app.inject({ method: 'DELETE', url: `/api/v1/admin/users/${f.alice.id}`, headers: headers(f.adminLogin) })).statusCode, 204);
  assert.ok(await f.store.getSession(session.id));
  assert.equal((await f.app.inject({ url: `/api/v1/admin/users/${f.alice.id}/sessions`, headers: headers(f.adminLogin) })).json().sessions.length, 1);
});

test('logout and access-token expiry are checked on every request', async t => {
  let time = Date.now(); const f = await fixture(t, { now: () => time, accessTtlMs: 1000 });
  assert.equal((await f.app.inject({ url: '/api/v1/models', headers: headers(f.aliceLogin) })).statusCode, 200);
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: headers(f.aliceLogin) })).statusCode, 204);
  assert.equal((await f.app.inject({ url: '/api/v1/models', headers: headers(f.aliceLogin) })).statusCode, 401);
  time += 1001;
  assert.equal((await f.app.inject({ url: '/api/v1/models', headers: headers(f.bobLogin) })).statusCode, 401);
});

test('admin-issued passwords allow ten characters while self changes and bootstrap retain twelve', async t => {
  const f = await fixture(t);
  const temporary = 'Abc123xYz9', reset = 'Def456uVw8';
  assert.equal(temporary.length, 10); assert.equal(reset.length, 10);
  const create = (value: string) => f.app.inject({ method: 'POST', url: '/api/v1/admin/users', headers: headers(f.adminLogin), payload: { username: 'temporary-user', displayName: '临时账号', role: 'employee', password: value } });
  assert.equal((await create(temporary.slice(1))).statusCode, 400);
  const created = await create(temporary); assert.equal(created.statusCode, 201, created.body);
  const id = created.json().user.id;
  const login = (value: string) => f.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'temporary-user', password: value } });
  const first = await login(temporary); assert.equal(first.statusCode, 200);
  const self = (newPassword: string) => f.app.inject({ method: 'POST', url: '/api/v1/auth/change-password', headers: headers(first.json()), payload: { currentPassword: temporary, newPassword } });
  assert.equal((await self(reset)).statusCode, 400);
  assert.equal((await f.app.inject({ method: 'POST', url: `/api/v1/admin/users/${id}/reset-password`, headers: headers(f.adminLogin), payload: { password: reset.slice(1) } })).statusCode, 400);
  assert.equal((await f.app.inject({ url: '/api/v1/auth/me', headers: headers(first.json()) })).statusCode, 200);
  assert.equal((await f.app.inject({ method: 'POST', url: `/api/v1/admin/users/${id}/reset-password`, headers: headers(f.adminLogin), payload: { password: reset } })).statusCode, 204);
  assert.equal((await f.app.inject({ url: '/api/v1/auth/me', headers: headers(first.json()) })).statusCode, 401);
  assert.equal((await login(temporary)).statusCode, 401);
  const resetLogin = await login(reset); assert.equal(resetLogin.statusCode, 200);
  const permanent = 'Abcd1234Wxyz';
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/v1/auth/change-password', headers: headers(resetLogin.json()), payload: { currentPassword: reset, newPassword: permanent } })).statusCode, 204);
  assert.equal((await login(permanent)).statusCode, 200);
  // CLI bootstrap and self changes use the unchanged default minimum.
  await assert.rejects(hashPassword(temporary));
});

test('complete session events are isolated, ordered, idempotent and admin review is read-only', async t => {
  const f = await fixture(t);
  const header = { id: 'upstream-session', cwd: 'C:\\Work', parentSession: 'parent', custom: { value: [1, 2] } };
  const created = await f.app.inject({ method: 'POST', url: '/api/v1/sessions', headers: headers(f.aliceLogin), payload: { id: 'session-a', ownerId: f.bob.id, title: '项目分析', upstreamHeader: header, inheritedEventCount: 2 } });
  assert.equal(created.statusCode, 201); const session = created.json().session;
  assert.equal(session.ownerId, f.alice.id); assert.equal(session.inheritedEventCount, 2); assert.deepEqual(session.upstreamHeader, header);
  for (const account of [f.bobLogin, f.adminLogin]) assert.equal((await f.app.inject({ url: `/api/v1/sessions/${session.id}/events`, headers: headers(account) })).statusCode, 404);
  assert.equal((await f.app.inject({ url: '/api/v1/sessions', headers: headers(f.bobLogin) })).json().sessions.length, 0);
  assert.equal((await f.app.inject({ method: 'POST', url: `/api/v1/sessions/${session.id}/lease`, headers: headers(f.aliceLogin), payload: { deviceId: f.bobLogin.deviceId } })).statusCode, 403);
  const lease = (await f.app.inject({ method: 'POST', url: `/api/v1/sessions/${session.id}/lease`, headers: headers(f.aliceLogin), payload: { deviceId: f.aliceLogin.deviceId } })).json();
  const otherDevice = await f.login('alice');
  assert.equal((await f.app.inject({ method: 'POST', url: `/api/v1/sessions/${session.id}/lease`, headers: headers(otherDevice), payload: { deviceId: otherDevice.deviceId } })).statusCode, 409);
  const events = [{ seq: 0, event: { type: 'turn/start', seq: 0, time: 10, custom: '完整保留' } }, { seq: 1, event: { type: 'tool/call', seq: 1, id: 't1', name: 'bash', input: { command: 'echo hello' }, nested: [{ arbitrary: true }] } }];
  const append = (batch = events) => f.app.inject({ method: 'POST', url: `/api/v1/sessions/${session.id}/events`, headers: headers(f.aliceLogin), payload: { leaseId: lease.leaseId, expectedNextSeq: 0, events: batch } });
  assert.equal((await append()).statusCode, 200); assert.equal((await append()).json().nextSeq, 2);
  const conflict = structuredClone(events); conflict[0].event.custom = '被修改'; assert.equal((await append(conflict)).statusCode, 409);
  const read = await f.app.inject({ url: `/api/v1/sessions/${session.id}/events?afterSeq=-1&limit=100`, headers: headers(f.aliceLogin) });
  assert.deepEqual(read.json().events, events); assert.equal(read.json().nextSeq, 2);
  assert.equal((await f.app.inject({ url: `/api/v1/admin/sessions/${session.id}/events`, headers: headers(f.adminLogin) })).statusCode, 200);
  assert.ok(f.store.audits.some(entry => entry.actorId === f.admin.id && entry.action === 'admin.session.events.read' && entry.targetId === session.id));
  assert.equal((await f.app.inject({ method: 'POST', url: `/api/v1/sessions/${session.id}/events`, headers: headers(f.adminLogin), payload: { leaseId: lease.leaseId, expectedNextSeq: 0, events } })).statusCode, 404);
});

test('expired lease cannot append and a new device can recover saved events', async t => {
  let time = Date.now(); const f = await fixture(t, { now: () => time, leaseTtlMs: 100 });
  const session = await f.store.createSession(f.alice.id, { id: 'lease-expiry' });
  const lease = (await f.app.inject({ method: 'POST', url: `/api/v1/sessions/${session.id}/lease`, headers: headers(f.aliceLogin), payload: { deviceId: f.aliceLogin.deviceId } })).json();
  time += 101;
  const events = [{ seq: 0, event: { type: 'user/message', content: 'hello' } }];
  assert.equal((await f.app.inject({ method: 'POST', url: `/api/v1/sessions/${session.id}/events`, headers: headers(f.aliceLogin), payload: { leaseId: lease.leaseId, expectedNextSeq: 0, events } })).statusCode, 409);
  const login = await f.login('alice');
  assert.equal((await f.app.inject({ method: 'POST', url: `/api/v1/sessions/${session.id}/lease`, headers: headers(login), payload: { deviceId: login.deviceId } })).statusCode, 200);
});

test('chat gateway strips company credentials and forwards SSE and upstream usage', async t => {
  let captured: { request: IncomingMessage; body: any } | undefined;
  const origin = await upstream(t, (request, response, body) => {
    captured = { request, body: JSON.parse(body.toString()) };
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write('data: {"choices":[{"delta":{"content":"你好"}}]}\n\n');
    response.end('data: {"usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14},"choices":[]}\n\ndata: [DONE]\n\n');
  });
  const f = await fixture(t, { upstreamBaseUrl: origin, upstreamKey: 'server-only-secret', allowInsecureUpstream: true });
  const result = await f.app.inject({ method: 'POST', url: '/api/v1/gateway/deepseek/chat/completions', headers: { ...headers(f.aliceLogin), 'x-api-key': 'client-evil', 'x-extra': 'never-forward' }, payload: { model: 'deepseek-flash', messages: [{ role: 'user', content: 'hello' }], stream: true, thinking: { type: 'enabled' }, user: 'forged', usage: { total_tokens: 0 } } });
  assert.equal(result.statusCode, 200, result.body); assert.match(result.body, /你好/); assert.match(result.body, /\[DONE\]/);
  assert.equal(captured?.request.headers.authorization, 'Bearer server-only-secret'); assert.equal(captured?.request.headers['x-api-key'], undefined); assert.equal(captured?.request.headers['x-extra'], undefined);
  assert.equal(captured?.body.user, f.alice.id); assert.deepEqual(captured?.body.thinking, { type: 'enabled' });
  assert.ok(!JSON.stringify(captured?.request.headers).includes(f.aliceLogin.accessToken));
  assert.equal(f.store.usages.at(-1)?.totalTokens, 14); assert.equal(f.store.usages.at(-1)?.status, 'completed');
});

test('native Messages preserves protocol headers and accumulates input/output usage', async t => {
  let captured: { path: string | undefined; headers: IncomingMessage['headers']; body: any } | undefined;
  const origin = await upstream(t, (request, response, body) => {
    captured = { path: request.url, headers: request.headers, body: JSON.parse(body.toString()) };
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":0}}}\n\n');
    response.end('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":3}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
  });
  const f = await fixture(t, { upstreamBaseUrl: origin, upstreamKey: 'native-key', allowInsecureUpstream: true });
  const result = await f.app.inject({ method: 'POST', url: '/api/v1/gateway/deepseek/anthropic/v1/messages', headers: { ...headers(f.aliceLogin), 'anthropic-version': '2023-06-01', 'anthropic-beta': 'files-api-2025-04-14', 'x-api-key': 'evil' }, payload: { model: 'deepseek-flash', messages: [{ role: 'user', content: 'hello' }], stream: true, metadata: { user_id: 'forged' } } });
  assert.equal(result.statusCode, 200, result.body); assert.match(result.body, /event: message_stop/);
  assert.equal(captured?.path, '/anthropic/v1/messages'); assert.equal(captured?.headers['x-api-key'], 'native-key'); assert.equal(captured?.headers.authorization, undefined);
  assert.equal(captured?.headers['anthropic-beta'], 'files-api-2025-04-14'); assert.equal(captured?.body.metadata.user_id, f.alice.id);
  assert.equal(f.store.usages.at(-1)?.inputTokens, 5); assert.equal(f.store.usages.at(-1)?.outputTokens, 3); assert.equal(f.store.usages.at(-1)?.totalTokens, 8);
});

test('gateway rejects unknown routes/models, redacts upstream errors and refuses redirects', async t => {
  let requests = 0;
  const origin = await upstream(t, (_request, response) => { requests++; response.writeHead(400, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'Authorization: secret-canary' } })); });
  const f = await fixture(t, { upstreamBaseUrl: origin, upstreamKey: 'secret-canary', allowInsecureUpstream: true });
  const payload = { model: 'deepseek-flash', messages: [{ role: 'user', content: 'hello' }] };
  const response = await f.app.inject({ method: 'POST', url: '/api/v1/gateway/deepseek/chat/completions', headers: headers(f.aliceLogin), payload });
  assert.equal(response.statusCode, 502); assert.ok(!response.body.includes('secret-canary'));
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/v1/gateway/deepseek/chat/completions', headers: headers(f.aliceLogin), payload: { ...payload, model: 'unauthorized-model' } })).statusCode, 400);
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/v1/gateway/deepseek/proxy?url=http://example.com', headers: headers(f.aliceLogin), payload })).statusCode, 404);
  assert.equal(requests, 1);
  let redirected = 0;
  const target = await upstream(t, (_request, response) => { redirected++; response.end('{}'); });
  const redirect = await upstream(t, (_request, response) => { response.writeHead(307, { location: `${target}/stolen` }); response.end(); });
  const redirectApp = buildApp(f.store, { ...configFromEnv({}), upstreamBaseUrl: redirect, upstreamKey: 'secret-canary', allowInsecureUpstream: true });
  t.after(() => redirectApp.close());
  assert.equal((await redirectApp.inject({ method: 'POST', url: '/api/v1/gateway/deepseek/chat/completions', headers: headers(f.aliceLogin), payload })).statusCode, 502); assert.equal(redirected, 0);
});

test('search and fetch map only to fixed tool endpoints', async t => {
  const seen: string[] = [];
  const origin = await upstream(t, (request, response) => { seen.push(request.url!); response.setHeader('Content-Type', 'application/json'); response.end('{"data":[]}'); });
  const f = await fixture(t, { upstreamBaseUrl: origin, upstreamKey: 'tools-key', allowInsecureUpstream: true });
  for (const route of ['search', 'fetch']) assert.equal((await f.app.inject({ method: 'POST', url: `/api/v1/gateway/deepseek/${route}`, headers: headers(f.aliceLogin), payload: { query: '设备资料', url: 'https://example.com' } })).statusCode, 200);
  assert.deepEqual(seen, ['/v1/tools/search', '/v1/tools/fetch']);
});

test('Files uploads are archived and isolated across users, admins, list and model references', async t => {
  let fileCalls = 0; let modelCalls = 0;
  const metadata = { id: 'file-test-1', type: 'file', mime_type: 'image/png', size_bytes: 4, created_at: new Date().toISOString(), filename: 'sample.png' };
  const origin = await upstream(t, (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/anthropic/v1/messages') { modelCalls++; response.end('{"id":"message-test","content":[]}'); return; }
    fileCalls++; assert.equal(request.headers['x-api-key'], 'files-key');
    response.end(JSON.stringify(request.method === 'DELETE' ? { id: metadata.id, type: 'file_deleted' } : metadata));
  });
  const f = await fixture(t, { upstreamBaseUrl: origin, upstreamKey: 'files-key', allowInsecureUpstream: true });
  const form = new FormData(); form.set('file', new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' }), 'sample.png'); form.set('expires_after[seconds]', '3600');
  const multipart = new Request('http://localhost/upload', { method: 'POST', body: form });
  const uploaded = await f.app.inject({ method: 'POST', url: '/api/v1/gateway/deepseek/anthropic/v1/files', headers: { ...headers(f.aliceLogin), 'content-type': multipart.headers.get('content-type')! }, payload: Buffer.from(await multipart.arrayBuffer()) });
  assert.equal(uploaded.statusCode, 200, uploaded.body); assert.deepEqual(uploaded.json(), metadata);
  assert.deepEqual(f.store.fileContents.get(metadata.id), Buffer.from([1, 2, 3, 4]));
  for (const login of [f.bobLogin, f.adminLogin]) {
    const list = await f.app.inject({ url: '/api/v1/gateway/deepseek/anthropic/v1/files', headers: headers(login) }); assert.deepEqual(list.json().data, []);
    for (const method of ['GET', 'DELETE'] as const) assert.equal((await f.app.inject({ method, url: `/api/v1/gateway/deepseek/anthropic/v1/files/${metadata.id}`, headers: headers(login) })).statusCode, 404);
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/v1/gateway/deepseek/anthropic/v1/messages', headers: headers(login), payload: { model: 'deepseek-flash', messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'file', file_id: metadata.id } }] }] } })).statusCode, 404);
  }
  assert.equal(fileCalls, 1); assert.equal(modelCalls, 0);
  assert.equal((await f.app.inject({ url: '/api/v1/gateway/deepseek/anthropic/v1/files', headers: headers(f.aliceLogin) })).json().data.length, 1);
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/v1/gateway/deepseek/anthropic/v1/messages', headers: headers(f.aliceLogin), payload: { model: 'deepseek-flash', messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'file', file_id: metadata.id } }] }] } })).statusCode, 200);
  assert.equal((await f.app.inject({ method: 'DELETE', url: `/api/v1/gateway/deepseek/anthropic/v1/files/${metadata.id}`, headers: headers(f.aliceLogin) })).statusCode, 200);
  assert.equal((await f.app.inject({ url: '/api/v1/gateway/deepseek/anthropic/v1/files', headers: headers(f.aliceLogin) })).json().data.length, 0);
  assert.ok(f.store.fileContents.has(metadata.id), 'archive remains after remote file deletion');
});

test('login attempts are rate limited before repeated KDF work', async t => {
  const f = await fixture(t);
  let last;
  for (let attempt = 0; attempt < 16; attempt++) last = await f.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'missing-user', password: 'bad-password' } });
  assert.equal(last?.statusCode, 429);
});

test('refresh keeps an admitted stream alive but account disable terminates it', async t => {
  let upstreamClosed = false;
  const origin = await upstream(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const frame = `data: ${JSON.stringify({ choices: [{ delta: { content: 'continuing-output-'.repeat(20) } }] })}\n\n`;
    response.write(frame);
    const timer = setInterval(() => response.write(frame), 100);
    response.on('close', () => { clearInterval(timer); upstreamClosed = true; });
  });
  const f = await fixture(t, { upstreamBaseUrl: origin, upstreamKey: 'long-stream-key', allowInsecureUpstream: true, maxConcurrent: 1, maxUserConcurrent: 1 });
  const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
  const response = await fetch(`${address}/api/v1/gateway/deepseek/chat/completions`, { method: 'POST', headers: { ...headers(f.aliceLogin), 'content-type': 'application/json' }, body: JSON.stringify({ model: 'deepseek-flash', messages: [{ role: 'user', content: 'long task' }], stream: true }) });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader(); await reader.read();
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/v1/gateway/deepseek/search', headers: headers(f.bobLogin), payload: { query: 'while streaming' } })).statusCode, 429, 'a completed request body must not release an ongoing SSE response');
  const refreshed = await f.app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: f.aliceLogin.refreshToken } });
  assert.equal(refreshed.statusCode, 200);
  await new Promise(resolve => setTimeout(resolve, 1150));
  assert.equal(upstreamClosed, false, 'token rotation must not revoke an admitted stream');
  await f.store.updateUser(f.alice.id, { status: 'disabled' });
  const drain = (async () => { while (!(await reader.read()).done) {} })();
  await Promise.race([drain, new Promise<never>((_resolve, reject) => { const timeout = setTimeout(() => reject(new Error('revoked stream did not stop')), 4000); timeout.unref(); })]);
  assert.equal(f.store.usages.at(-1)?.status, 'cancelled');
});

test('business file_id fields in tool inputs and schemas are not provider file references', async t => {
  let calls = 0;
  const origin = await upstream(t, (_request, response) => { calls++; response.setHeader('Content-Type', 'application/json'); response.end('{"content":[],"usage":{"input_tokens":1,"output_tokens":1}}'); });
  const f = await fixture(t, { upstreamBaseUrl: origin, upstreamKey: 'test-key', allowInsecureUpstream: true });
  const result = await f.app.inject({ method: 'POST', url: '/api/v1/gateway/deepseek/anthropic/v1/messages', headers: headers(f.aliceLogin), payload: {
    model: 'deepseek-flash',
    messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'document_lookup', input: { file_id: 'ERP-file-123', nested: { type: 'image', source: { type: 'file', file_id: 'business-only' } } } }] }],
    tools: [{ name: 'document_lookup', input_schema: { type: 'object', properties: { file_id: { type: 'string' } } } }],
  } });
  assert.equal(result.statusCode, 200, result.body); assert.equal(calls, 1);
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/v1/gateway/deepseek/anthropic/v1/messages', headers: headers(f.aliceLogin), payload: { model: 'deepseek-flash', messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: [{ type: 'image', source: { type: 'file', file_id: 'unowned-provider-file' } }] }] }] } })).statusCode, 404);
});

test('Files admission rejects an unfinished concurrent upload before buffering and abort releases exactly once', async t => {
  assert.equal(configFromEnv({}).maxConcurrentUploads, 1);
  assert.equal(configFromEnv({ RUFA_MAX_CONCURRENT_UPLOADS: '2' }).maxConcurrentUploads, 2);
  assert.throws(() => configFromEnv({ RUFA_MAX_CONCURRENT_UPLOADS: '0' }));
  let uploaded = 0;
  const origin = await upstream(t, (_request, response) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ id: `file-${++uploaded}`, type: 'file' })); });
  const f = await fixture(t, { upstreamBaseUrl: origin, upstreamKey: 'test-only', allowInsecureUpstream: true, maxConcurrent: 4, maxUserConcurrent: 4 });
  const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
  const path = '/api/v1/gateway/deepseek/anthropic/v1/files';
  for (let iteration = 0; iteration < 2; iteration++) {
    const held = await pendingRequest(t, f.app, address, path, f.aliceLogin.accessToken, 'multipart/form-data; boundary=test');
    const denied = await pendingRequest(t, f.app, address, path, f.bobLogin.accessToken, 'multipart/form-data; boundary=test');
    assert.equal((await denied.response).status, 429);
    assert.equal(uploaded, iteration, 'no incomplete or rejected upload reaches upstream');
    const unauthenticated = await pendingRequest(t, f.app, address, path, 'invalid-token', 'multipart/form-data; boundary=test');
    assert.equal((await unauthenticated.response).status, 401, 'authenticate before deciding concurrency');
    await held.abort();
    const form = new FormData(); form.set('file', new Blob(['file']), 'small.txt');
    const completed = await fetch(`${address}${path}`, { method: 'POST', headers: headers(f.bobLogin), body: form });
    assert.equal(completed.status, 200, await completed.text());
    // Starting another held request must still block another upload: finish and
    // close of the previous request must not decrement the counters twice.
  }
  assert.equal(uploaded, 2);
});

test('all JSON gateway paths reserve global and per-user slots before parsing their bodies', async t => {
  const origin = await upstream(t, (_request, response) => { response.setHeader('Content-Type', 'application/json'); response.end('{}'); });
  const f = await fixture(t, { upstreamBaseUrl: origin, upstreamKey: 'test-only', allowInsecureUpstream: true, maxConcurrent: 2, maxUserConcurrent: 1 });
  const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
  for (const route of ['chat/completions', 'anthropic/v1/messages', 'search', 'fetch']) {
    const path = `/api/v1/gateway/deepseek/${route}`;
    const first = await pendingRequest(t, f.app, address, path, f.aliceLogin.accessToken);
    const sameUser = await pendingRequest(t, f.app, address, path, f.aliceLogin.accessToken);
    assert.equal((await sameUser.response).status, 429, route);
    const second = await pendingRequest(t, f.app, address, path, f.bobLogin.accessToken);
    const global = await pendingRequest(t, f.app, address, path, f.adminLogin.accessToken);
    assert.equal((await global.response).status, 429, route);
    await first.abort(); await second.abort();
    const completed = await fetch(`${address}${path}`, { method: 'POST', headers: { ...headers(f.aliceLogin), 'content-type': 'application/json' }, body: JSON.stringify({ model: 'deepseek-flash', messages: [{ role: 'user', content: 'test' }] }) });
    assert.equal(completed.status, 200, await completed.text());
  }
});

test('parser errors, oversized bodies and failed multipart decoding release gateway slots', async t => {
  const origin = await upstream(t, (request, response) => { response.setHeader('Content-Type', 'application/json'); response.end(request.url?.endsWith('/files') ? '{"id":"file-recovered","type":"file"}' : '{}'); });
  const f = await fixture(t, { upstreamBaseUrl: origin, upstreamKey: 'test-only', allowInsecureUpstream: true, maxConcurrent: 1, maxUserConcurrent: 1, bodyLimitBytes: 512, fileUploadLimitBytes: 512 });
  const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
  const send = async (route: string, body: string, contentType: string) => {
    const result = await fetch(`${address}/api/v1/gateway/deepseek/${route}`, { method: 'POST', headers: { ...headers(f.aliceLogin), 'content-type': contentType }, body });
    await result.text(); return result.status;
  };
  const failures = [
    ['chat/completions', '{broken', 'application/json', 400],
    ['chat/completions', 'x'.repeat(513), 'application/json', 413],
    ['chat/completions', 'body', 'application/unknown', 415],
    ['anthropic/v1/files', 'invalid multipart', 'multipart/form-data; boundary=test', 400],
    ['anthropic/v1/files', 'x'.repeat(513), 'multipart/form-data; boundary=test', 413],
  ] as const;
  for (const [route, body, contentType, expected] of failures) {
    assert.equal(await send(route, body, contentType), expected);
    assert.equal(await send('chat/completions', JSON.stringify({ model: 'deepseek-flash', messages: [{ role: 'user', content: 'works' }] }), 'application/json'), 200);
  }
  const form = new FormData(); form.set('file', new Blob(['file']), 'small.txt');
  const result = await fetch(`${address}/api/v1/gateway/deepseek/anthropic/v1/files`, { method: 'POST', headers: headers(f.aliceLogin), body: form });
  assert.equal(result.status, 200, await result.text());
});

test('DeepSeek settings are admin-only, never returned, and recheck the current role', async t => {
  const secret = await secretFixture(t);
  const f = await fixture(t, {}, secret.settings);
  const path = '/api/v1/admin/settings/deepseek';
  assert.equal((await f.app.inject({ url: path })).statusCode, 401);
  for (const method of ['GET', 'PUT'] as const) assert.equal((await f.app.inject({ method, url: path, headers: headers(f.aliceLogin), ...(method === 'PUT' ? { payload: { apiKey: 'employee-must-not-set-this' } } : {}) })).statusCode, 403);
  assert.deepEqual((await f.app.inject({ url: path, headers: headers(f.adminLogin) })).json(), { configured: false, updatedAt: null });
  const saved = await f.app.inject({ method: 'PUT', url: path, headers: headers(f.adminLogin), payload: { apiKey: 'sk-admin-secret-canary' } });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.deepEqual(Object.keys(saved.json()).sort(), ['configured', 'updatedAt']);
  assert.equal(saved.json().configured, true); assert.ok(Number.isFinite(Date.parse(saved.json().updatedAt)));
  const state = await f.app.inject({ url: path, headers: headers(f.adminLogin) });
  assert.deepEqual(state.json(), saved.json()); assert.ok(!state.body.includes('sk-admin-secret-canary'));
  for (const payload of [{ apiKey: '' }, { apiKey: 'bad\nheader' }, { apiKey: 'new', baseURL: 'https://evil.example' }]) assert.equal((await f.app.inject({ method: 'PUT', url: path, headers: headers(f.adminLogin), payload })).statusCode, 400);
  assert.equal(secret.settings.currentKey(), 'sk-admin-secret-canary');
  assert.ok(f.store.audits.some(entry => entry.action === 'admin.settings.deepseek.update.requested'));
  assert.ok(!JSON.stringify(f.store.audits).includes('sk-admin-secret-canary'));
  await f.store.createUser({ username: 'second-admin', displayName: '第二管理', role: 'admin', passwordHash });
  await f.store.updateUser(f.admin.id, { role: 'employee' });
  assert.equal((await f.app.inject({ url: path, headers: headers(f.adminLogin) })).statusCode, 401, 'role changes revoke the old login');
  const demoted = await f.login('admin');
  for (const method of ['GET', 'PUT'] as const) assert.equal((await f.app.inject({ method, url: path, headers: headers(demoted), ...(method === 'PUT' ? { payload: { apiKey: 'demoted-must-not-set' } } : {}) })).statusCode, 403);
});

test('secret file survives restart, overrides the environment, serializes writes and fails closed if corrupt', async t => {
  const secret = await secretFixture(t, 'env-initial-only');
  assert.deepEqual(secret.settings.status(), { configured: true, updatedAt: null });
  await assert.rejects(readFile(secret.path), { code: 'ENOENT' });
  const saved = await secret.settings.update('sk-saved-key');
  const restarted = await DeepSeekSettings.open(secret.path, 'env-must-not-override');
  assert.equal(restarted.currentKey(), 'sk-saved-key'); assert.deepEqual(restarted.status(), saved);
  if (process.platform !== 'win32') {
    assert.equal((await stat(secret.path)).mode & 0o777, 0o600);
    assert.equal((await stat(dirname(secret.path))).mode & 0o777, 0o700);
  }
  await Promise.all([restarted.update('sk-next-one'), restarted.update('sk-next-two')]);
  assert.equal(restarted.currentKey(), 'sk-next-two');
  assert.equal((await DeepSeekSettings.open(secret.path)).currentKey(), restarted.currentKey());
  assert.deepEqual(await readdir(dirname(secret.path)), ['deepseek.json'], 'no temporary secret files remain');
  await writeFile(secret.path, '{malformed-secret-canary', 'utf8');
  await assert.rejects(DeepSeekSettings.open(secret.path, 'env-fallback'), error => error instanceof Error && error.message === 'Cannot load server secret configuration');
});

test('a failed atomic save keeps the previous active and persisted key without exposing errors', async t => {
  const secret = await secretFixture(t);
  const originalStatus = await secret.settings.update('sk-original-canary');
  const f = await fixture(t, {}, secret.settings);
  const originalDirectory = dirname(secret.path);
  const backupDirectory = join(secret.folder, 'preserved-secrets');
  await rename(originalDirectory, backupDirectory);
  await writeFile(originalDirectory, 'block directory creation');
  const response = await f.app.inject({ method: 'PUT', url: '/api/v1/admin/settings/deepseek', headers: headers(f.adminLogin), payload: { apiKey: 'sk-rejected-canary' } });
  assert.equal(response.statusCode, 503); assert.equal(response.json().error.code, 'SECRET_SAVE_FAILED');
  assert.ok(!response.body.includes('canary')); assert.ok(!response.body.includes(secret.folder));
  assert.equal(secret.settings.currentKey(), 'sk-original-canary'); assert.deepEqual(secret.settings.status(), originalStatus);
  assert.equal(JSON.parse(await readFile(join(backupDirectory, 'deepseek.json'), 'utf8')).apiKey, 'sk-original-canary');
  await unlink(originalDirectory); await rename(backupDirectory, originalDirectory);
  assert.equal((await DeepSeekSettings.open(secret.path)).currentKey(), 'sk-original-canary');
  assert.ok(!JSON.stringify(f.store.audits).includes('canary'));
});

test('admin key replacement immediately changes subsequent mock calls while inflight SSE keeps its old key', async t => {
  const secret = await secretFixture(t, 'sk-old-canary');
  const captured: Array<{ path: string; authorization: string | undefined; apiKey: string | string[] | undefined }> = [];
  let firstStarted!: () => void;
  const first = new Promise<void>(resolve => { firstStarted = resolve; });
  let running: ServerResponse | undefined;
  const origin = await upstream(t, (request, response, raw) => {
    captured.push({ path: request.url!, authorization: request.headers.authorization, apiKey: request.headers['x-api-key'] });
    if (request.url === '/anthropic/v1/messages' && JSON.parse(raw.toString()).stream) {
      running = response; response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write('data: {"text":"started"}\n\n'); firstStarted(); return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(request.url === '/anthropic/v1/files' ? '{"id":"file-new-key","type":"file","echo":"sk-new-canary"}' : '{"content":[],"echo":"sk-new-canary"}');
  });
  const f = await fixture(t, { upstreamBaseUrl: origin, allowInsecureUpstream: true }, secret.settings);
  const streaming = f.app.inject({ method: 'POST', url: '/api/v1/gateway/deepseek/anthropic/v1/messages', headers: headers(f.aliceLogin), payload: { model: 'deepseek-flash', messages: [{ role: 'user', content: 'run' }], stream: true } }).then(value => value);
  await first;
  const replacement = await f.app.inject({ method: 'PUT', url: '/api/v1/admin/settings/deepseek', headers: headers(f.adminLogin), payload: { apiKey: 'sk-new-canary' } });
  assert.equal(replacement.statusCode, 200);
  for (const route of ['chat/completions', 'anthropic/v1/messages', 'search', 'fetch']) {
    const result = await f.app.inject({ method: 'POST', url: `/api/v1/gateway/deepseek/${route}`, headers: headers(f.aliceLogin), payload: { model: 'deepseek-flash', messages: [{ role: 'user', content: 'new' }] } });
    assert.equal(result.statusCode, 200); assert.ok(!result.body.includes('sk-new-canary'));
  }
  const form = new FormData(); form.set('file', new Blob(['sample']), 'file.txt');
  const multipart = new Request('http://localhost/', { method: 'POST', body: form });
  const result = await f.app.inject({ method: 'POST', url: '/api/v1/gateway/deepseek/anthropic/v1/files', headers: { ...headers(f.aliceLogin), 'content-type': multipart.headers.get('content-type')! }, payload: Buffer.from(await multipart.arrayBuffer()) });
  assert.equal(result.statusCode, 200); assert.ok(!result.body.includes('sk-new-canary'));
  running!.end('data: {"text":"sk-old-canary"}\n\ndata: [DONE]\n\n');
  const completed = await streaming;
  assert.equal(completed.statusCode, 200); assert.ok(!completed.body.includes('sk-old-canary')); assert.match(completed.body, /\[REDACTED\]/);
  assert.equal(captured[0].apiKey, 'sk-old-canary');
  for (const call of captured.slice(1)) assert.equal(call.path.startsWith('/anthropic/') ? call.apiKey : call.authorization, call.path.startsWith('/anthropic/') ? 'sk-new-canary' : 'Bearer sk-new-canary');
  assert.ok(!JSON.stringify(f.store.audits).includes('canary'));
});

test('model catalogs always advertise a validated output budget bounded by the server policy', () => {
  const defaults = configFromEnv({});
  assert.equal(defaults.maxOutputTokens, 384000);
  assert.equal(defaults.models.length, 1);
  assert.equal(defaults.models[0].id, 'deepseek-flash');
  assert.equal(defaults.models[0].displayName, 'DeepSeek V4.1 Flash');
  assert.equal(defaults.models[0].contextWindow, 1000000);
  assert.equal(defaults.models[0].maxOutputTokens, 384000);
  assert.deepEqual(defaults.models[0].inputModalities, ['text', 'image']);
  assert.equal(configFromEnv({ RUFA_MAX_OUTPUT_TOKENS: '500000' }).models[0].maxOutputTokens, 384000, 'the fixed model limit still bounds a higher global budget');
  assert.equal(configFromEnv({ RUFA_MAX_OUTPUT_TOKENS: '131072' }).models[0].maxOutputTokens, 131072, 'an existing deployment must explicitly migrate its old environment limit');
  assert.equal(configFromEnv({ RUFA_MAX_OUTPUT_TOKENS: '2048' }).models[0].maxOutputTokens, 2048);
  const configured = configFromEnv({ RUFA_MAX_OUTPUT_TOKENS: '8192', RUFA_MODELS_JSON: JSON.stringify([
    { id: 'missing-cap', displayName: 'Missing' },
    { id: 'smaller-cap', displayName: 'Small', maxOutputTokens: 512 },
    { id: 'larger-cap', displayName: 'Large', maxOutputTokens: 256000, privateSetting: 'must-not-leak' },
  ]) });
  assert.deepEqual(configured.models.map(model => model.maxOutputTokens), [8192, 512, 8192]);
  assert.ok(!JSON.stringify(configured.models).includes('must-not-leak'));
  for (const maxOutputTokens of [null, 0, -1, 1.5, '2048', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => configFromEnv({ RUFA_MODELS_JSON: JSON.stringify([{ id: 'bad-cap', displayName: 'Bad', maxOutputTokens }]) }), /Invalid model output token limit/);
  }
});

test('published model caps match gateway defaults and limits while explicit lower budgets are preserved', async t => {
  const captured: Record<string, unknown>[] = [];
  const origin = await upstream(t, (_request, response, raw) => { captured.push(JSON.parse(raw.toString())); response.setHeader('Content-Type', 'application/json'); response.end('{"content":[]}'); });
  const models = [
    { id: 'deepseek-flash', displayName: 'Flash' },
    { id: 'smaller-cap', displayName: 'Small', maxOutputTokens: 1024 },
    { id: 'larger-cap', displayName: 'Large', maxOutputTokens: 256000 },
  ];
  const f = await fixture(t, { upstreamBaseUrl: origin, upstreamKey: 'test-only', allowInsecureUpstream: true, maxOutputTokens: 8192, models });
  const listed = (await f.app.inject({ url: '/api/v1/models', headers: headers(f.aliceLogin) })).json().models;
  assert.deepEqual(listed.map((model: { maxOutputTokens: number }) => model.maxOutputTokens), [8192, 1024, 8192]);
  assert.equal(models[2].maxOutputTokens, 256000, 'normalization does not mutate caller configuration');
  for (const model of listed) for (const route of ['chat/completions', 'anthropic/v1/messages']) {
    const send = (extra: Record<string, unknown>) => f.app.inject({ method: 'POST', url: `/api/v1/gateway/deepseek/${route}`, headers: headers(f.aliceLogin), payload: { model: model.id, messages: [{ role: 'user', content: '你好' }], ...extra } });
    assert.equal((await send({})).statusCode, 200);
    assert.equal(captured.at(-1)!.max_tokens, model.maxOutputTokens);
    // Existing company-model.mjs maps catalog maxOutputTokens to adapter maxTokens.
    assert.equal((await send({ max_tokens: model.maxOutputTokens })).statusCode, 200);
    assert.equal(captured.at(-1)!.max_tokens, model.maxOutputTokens);
    assert.equal((await send({ max_tokens: 37 })).statusCode, 200);
    assert.equal(captured.at(-1)!.max_tokens, 37, 'an explicitly smaller cap passes through unchanged');
    if (route === 'chat/completions') {
      assert.equal((await send({ max_completion_tokens: 19 })).statusCode, 200);
      assert.equal(captured.at(-1)!.max_completion_tokens, 19);
      assert.equal(captured.at(-1)!.max_tokens, undefined, 'do not inject a competing default for an explicit cap');
    }
    const calls = captured.length;
    for (const field of ['max_tokens', 'max_completion_tokens']) for (const value of [model.maxOutputTokens + 1, 256000, 0, -1, 1.5, '1024', null]) {
      assert.equal((await send({ [field]: value })).statusCode, 400);
    }
    assert.equal((await send({ max_tokens: 37, max_completion_tokens: model.maxOutputTokens + 1 })).statusCode, 400);
    assert.equal(captured.length, calls, 'invalid or over-budget requests never reach the provider');
  }
});

test('DeepSeek V4.1 Flash advertises the fixed 1M/image catalog and enforces the 384000 output boundary', async t => {
  const captured: Record<string, unknown>[] = [];
  const origin = await upstream(t, (_request, response, raw) => { captured.push(JSON.parse(raw.toString())); response.setHeader('Content-Type', 'application/json'); response.end('{"content":[]}'); });
  const f = await fixture(t, { upstreamBaseUrl: origin, upstreamKey: 'mock-only-cap-test', allowInsecureUpstream: true });
  const catalog = (await f.app.inject({ url: '/api/v1/models', headers: headers(f.aliceLogin) })).json();
  assert.deepEqual(catalog.models, [{ id: 'deepseek-flash', displayName: 'DeepSeek V4.1 Flash', inputModalities: ['text', 'image'], contextWindow: 1000000, maxOutputTokens: 384000 }]);
  for (const route of ['chat/completions', 'anthropic/v1/messages']) {
    const send = (extra: Record<string, unknown>) => f.app.inject({ method: 'POST', url: `/api/v1/gateway/deepseek/${route}`, headers: headers(f.aliceLogin), payload: { model: 'deepseek-flash', messages: [{ role: 'user', content: '你好' }], ...extra } });
    for (const extra of [{}, { max_tokens: 384000 }, { max_tokens: 8192 }]) assert.equal((await send(extra)).statusCode, 200);
    assert.deepEqual(captured.slice(-3).map(value => value.max_tokens), [384000, 384000, 8192]);
    const before = captured.length;
    for (const field of ['max_tokens', 'max_completion_tokens']) assert.equal((await send({ [field]: 384001 })).statusCode, 400);
    assert.equal(captured.length, before, 'above-limit requests must not be sent upstream');
    if (route === 'chat/completions') {
      for (const cap of [384000, 8192]) {
        assert.equal((await send({ max_completion_tokens: cap })).statusCode, 200);
        assert.equal(captured.at(-1)!.max_completion_tokens, cap);
        assert.equal(captured.at(-1)!.max_tokens, undefined);
      }
    }
  }
});
