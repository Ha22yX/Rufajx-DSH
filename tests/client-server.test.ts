import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { buildApp } from '../apps/server/src/app.ts';
import { configFromEnv } from '../apps/server/src/config.ts';
import { hashPassword } from '../apps/server/src/security.ts';
import { SqliteStore } from '../apps/server/src/sqlite-store.ts';
import { DeepSeekSettings } from '../apps/server/src/deepseek-settings.ts';
import { CompanyApi } from '../apps/client/src/company-api.ts';
import { RuntimeBridge } from '../apps/client/src/runtime-bridge.ts';
import { AdminTools } from '../apps/client/src/admin-tools.ts';
import type { CredentialStore, SavedLogin, ManagedUser, SessionSummary } from '../apps/client/src/types.ts';

class TestVault implements CredentialStore {
  saved: SavedLogin | null = null;
  async read() { return this.saved ? { ...this.saved } : null; }
  async write(value: SavedLogin) { this.saved = { ...value }; }
  async clear() { this.saved = null; }
}

const password = 'Integration-only-password-2026';
const upstreamKey = 'mock-upstream-key-never-a-production-secret';

test('管理员agent工具服务端鉴权、人工取消、聊天密码交付、查询及账号切换后确认失效', async t => {
  const { manager, createEmployee, url } = await fixture(t);
  const employee = await createEmployee('agent-tools-employee');
  const confirmations: any[] = [], revealed: string[] = [];
  let approve = true, beforeApproval: (() => Promise<void>) | undefined;
  const tools = new AdminTools(manager, {
    confirm: async action => { confirmations.push(action); await beforeApproval?.(); return approve; },
    revealPassword: async (_account, value) => { revealed.push(value); },
  });
  const signal = new AbortController().signal;
  const forbidden = new AdminTools(employee.api, { confirm: async () => { throw new Error('Employee must never get an approval dialog'); }, revealPassword: async () => {} });
  await assert.rejects(forbidden.execute('list_users', {}, signal), (error: any) => error.status === 403);
  await assert.rejects(employee.api.json('GET', '/admin/users'), (error: any) => error.status === 403);
  await assert.rejects(tools.execute('delete_user', { userId: employee.user.id, approved: true }, signal), (error: any) => error.code === 'INVALID_INPUT');
  const created: any = await tools.execute('create_user', { username: 'agent-created', displayName: '工具创建员工' }, signal);
  assert.equal(created.ok, true); assert.equal(revealed.length, 0, 'No separate password window');
  assert.match(created.initialPassword, /^[A-Za-z0-9]{10}$/); assert.match(created.initialPassword, /[0-9]/); assert.match(created.initialPassword, /[A-Za-z]/);
  assert.equal(created.account.role, '员工'); assert.equal(created.account.id, undefined); assert.equal(created.result, undefined);
  assert.equal(confirmations[0].title, '创建账号：工具创建员工（agent-created）');
  const target = new CompanyApi(new TestVault(), true); await target.login(url, 'agent-created', created.initialPassword);
  const userId = target.state.user!.id;
  approve = false;
  assert.equal((await tools.execute('delete_user', { userId }, signal) as any).cancelled, true);
  assert.equal((await target.verify()).user!.id, userId);
  approve = true;
  const reset: any = await tools.execute('reset_password', { userId }, signal);
  assert.equal(revealed.length, 0); assert.match(reset.newPassword, /^[A-Za-z0-9]{10}$/);
  await assert.rejects(target.verify(), (error: any) => error.status === 401);
  await target.login(url, 'agent-created', reset.newPassword);
  const { session } = await target.json<{ session: SessionSummary }>('POST', '/sessions', { title: '管理员工具查询' });
  const lease = await target.json<{ leaseId: string }>('POST', `/sessions/${session.id}/lease`, { deviceId: target.state.deviceId });
  await target.json('POST', `/sessions/${session.id}/events`, { leaseId: lease.leaseId, expectedNextSeq: 0, events: [{ seq: 0, event: { seq: 0, type: 'message', data: { text: '这是历史资料' } } }] });
  const sessions: any = await tools.execute('list_sessions', { userId }, signal);
  assert(sessions.sessions.some((item: any) => item.id === session.id));
  const chat: any = await tools.execute('read_chat', { sessionId: session.id }, signal);
  assert.equal(chat.events[0].event.data.text, '这是历史资料');
  beforeApproval = async () => { await manager.logout(); await manager.login(url, 'manager', password); };
  await assert.rejects(tools.execute('delete_user', { userId }, signal), (error: any) => error.code === 'APPROVAL_EXPIRED');
  assert.equal((await target.verify()).user!.id, userId);
  beforeApproval = undefined;
  const adminBridge = new RuntimeBridge(manager, tools), employeeBridge = new RuntimeBridge(employee.api);
  await adminBridge.start(); await employeeBridge.start();
  try {
    const invoke = (bridge: RuntimeBridge, action: string, body: unknown, extra: Record<string, string> = {}) => fetch(`${bridge.origin}/company/admin-tools/${action}`, { method: 'POST', headers: { 'x-rufa-bridge': bridge.token, 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) });
    assert.equal((await invoke(employeeBridge, 'list_users', {})).status, 403);
    assert.equal((await invoke(adminBridge, 'list_users', {}, { origin: 'https://untrusted.example' })).status, 403);
    const listed = await invoke(adminBridge, 'list_users', { search: 'agent-created' });
    assert.equal(listed.status, 200); assert.equal((await listed.json() as any).users.length, 1);
    const deleted = await invoke(adminBridge, 'delete_user', { userId });
    assert.equal(deleted.status, 200); assert.equal((await deleted.json() as any).ok, true);
    assert.equal(confirmations.at(-1).destructive, false, 'Deletion is reversible during the recycle period');
    await assert.rejects(target.verify(), (error: any) => error.status === 401);
    const history: any = await tools.execute('read_chat', { sessionId: session.id }, signal);
    assert.equal(history.events.length, 1);
    const trash: any = await tools.execute('list_deleted_users', { search: 'agent-created' }, signal);
    assert.equal(trash.users.length, 1); assert.ok(trash.users[0].purgeAfter); assert.equal(trash.users[0].purgedAt, null);
    assert.equal((await tools.execute('list_users', { search: 'agent-created' }, signal) as any).users.length, 0);
    const restored: any = await tools.execute('restore_user', { userId }, signal);
    assert.equal(restored.ok, true); assert.equal(restored.account.id, undefined);
    await target.login(url, 'agent-created', reset.newPassword);
    assert.equal((await target.json<any>(`GET`, `/sessions/${session.id}/events`)).events.length, 1);
  } finally { await adminBridge.stop(); await employeeBridge.stop(); }
});

test('管理工具创建和补写职位持久化，省略保留、显式清空、取消不写，登录资料与账号查询一致', async t => {
  const { manager, url, restart } = await fixture(t, true);
  let approved = true;
  const confirmations: any[] = [];
  const tools = new AdminTools(manager, { confirm: async action => { confirmations.push(action); return approved; } });
  const signal = new AbortController().signal;
  const created: any = await tools.execute('create_user', { username: 'job-fixture', displayName: '职位验收', jobTitle: '  研发  ' }, signal);
  assert.equal(created.account.jobTitle, '研发'); assert.equal(created.account.role, '员工'); assert.equal(created.account.id, undefined);
  assert.match(confirmations.at(-1).detail, /职位：研发/);
  const employee = new CompanyApi(new TestVault(), true);
  await employee.login(url, 'job-fixture', created.initialPassword);
  const userId = employee.state.user!.id;
  assert.equal(employee.state.user!.jobTitle, '研发');
  const queried: any = await tools.execute('list_users', { search: '研发' }, signal);
  assert.equal(queried.users.length, 1); assert.equal(queried.users[0].id, userId);
  await restart();
  assert.equal((await employee.verify()).user!.jobTitle, '研发');
  await tools.execute('update_user', { userId, displayName: '更名验收' }, signal);
  assert.equal((await employee.verify()).user!.jobTitle, '研发');
  approved = false;
  assert.equal((await tools.execute('update_user', { userId, jobTitle: '不应写入' }, signal) as any).cancelled, true);
  assert.equal((await employee.verify()).user!.jobTitle, '研发');
  approved = true;
  const changed: any = await tools.execute('update_user', { userId, jobTitle: ' 项目经理 ' }, signal);
  assert.equal(changed.account.jobTitle, '项目经理'); assert.match(confirmations.at(-1).detail, /职位：项目经理/);
  assert.equal((await employee.verify()).user!.jobTitle, '项目经理');
  for (const invalidTitle of [null, 7, 'a'.repeat(101)]) {
    const count = confirmations.length;
    await assert.rejects(tools.execute('update_user', { userId, jobTitle: invalidTitle }, signal), (error: any) => error.code === 'INVALID_INPUT');
    assert.equal(confirmations.length, count);
  }
  const cleared: any = await tools.execute('update_user', { userId, jobTitle: '' }, signal);
  assert.equal(cleared.account.jobTitle, ''); assert.match(confirmations.at(-1).detail, /职位：未填写/);
  await restart(); assert.equal((await employee.verify()).user!.jobTitle, '');
});

async function fixture(t: TestContext, closeConnections = false) {
  // Restart tests use fresh sockets so the global fetch pool cannot reuse a socket
  // from the process that has just closed. Production mutation retries stay unchanged.
  const transport: typeof fetch = closeConnections ? (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('connection', 'close');
    return fetch(input, { ...init, headers });
  } : fetch;
  const upstreamRequests: { path: string; headers: Record<string, unknown>; body: any }[] = [];
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    upstreamRequests.push({ path: req.url!, headers: { ...req.headers }, body });
    if (req.url !== '/anthropic/v1/messages') { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"mock","usage":{"input_tokens":9,"output_tokens":0}}}\n\n');
    res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"跨端联调成功"}}\n\n');
    res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n');
    res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamAddress = upstream.address();
  assert(upstreamAddress && typeof upstreamAddress !== 'string');
  const tempRoot = await mkdtemp(join(tmpdir(), 'rufa-http-sqlite-'));
  const databasePath = join(tempRoot, 'company.sqlite');
  let store = SqliteStore.open(databasePath);
  await store.createUser({ username: 'manager', displayName: '管理', role: 'admin', passwordHash: await hashPassword(password) }, true);
  const config = {
    ...configFromEnv({}),
    allowInsecureUpstream: true,
    upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    upstreamKey,
  };
  const secretFile = join(tempRoot, 'secrets', 'deepseek.json');
  let settings = await DeepSeekSettings.open(secretFile, upstreamKey);
  let app = buildApp(store, config, () => store.ping(), settings);
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(async () => {
    await app.close();
    await store.close();
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    assert.equal(dirname(resolve(tempRoot)), resolve(tmpdir()));
    assert(basename(tempRoot).startsWith('rufa-http-sqlite-'));
    await rm(tempRoot, { recursive: true, force: true });
  });
  const manager = new CompanyApi(new TestVault(), true, transport);
  await manager.login(url, 'manager', password);
  const createEmployee = async (username: string) => {
    const { user } = await manager.json<{ user: ManagedUser }>('POST', '/admin/users', { username, displayName: username, password, role: 'employee' });
    const vault = new TestVault();
    const api = new CompanyApi(vault, true, transport);
    await api.login(url, username, password);
    return { api, vault, user };
  };
  const restart = async () => {
    await app.close();
    await store.close();
    store = SqliteStore.open(databasePath);
    settings = await DeepSeekSettings.open(secretFile, upstreamKey);
    app = buildApp(store, config, () => store.ping(), settings);
    await app.listen({ host: '127.0.0.1', port: Number(new URL(url).port) });
  };
  const backup = async () => {
    const destination = join(tempRoot, 'backup.sqlite');
    await store.backupTo(destination);
    return destination;
  };
  return { manager, createEmployee, url, upstreamRequests, restart, backup, clientHome: join(tempRoot, 'client-home') };
}

test('真实客户端HTTP登录、管理建号与两角色权限匹配', async t => {
  const { manager, createEmployee } = await fixture(t);
  const employee = await createEmployee('employee-a');
  assert.equal(employee.api.state.user?.role, 'employee');
  assert.equal(manager.state.user?.role, 'admin');
  assert(employee.api.state.deviceId);
  assert.equal('accessToken' in employee.api.state, false);
  assert.equal('refreshToken' in employee.api.state, false);
  await assert.rejects(employee.api.json('GET', '/admin/users'), (e: any) => e.status === 403);
  const device = employee.api.state.deviceId;
  await employee.api.refresh();
  assert.equal(employee.api.state.deviceId, device);
  assert.equal((await employee.api.verify()).user?.id, employee.user.id);
  await assert.rejects(manager.json('DELETE', `/admin/users/${manager.state.user!.id}`), (e: any) => e.status === 400 && e.code === 'SELF_DELETE_NOT_ALLOWED');
  await assert.rejects(manager.json('PATCH', `/admin/users/${manager.state.user!.id}`, { role: 'employee' }), (e: any) => e.status === 409 && e.code === 'LAST_ADMIN');
  await manager.json('PATCH', `/admin/users/${employee.user.id}`, { status: 'disabled' });
  await assert.rejects(employee.api.verify(), (e: any) => e.status === 401);
  assert.equal(employee.api.state.user, null);
  assert.equal(employee.vault.saved, null);
});

test('跨端保存完整事件、重复提交幂等、员工隔离与管理只读', async t => {
  const { manager, createEmployee } = await fixture(t);
  const alice = await createEmployee('alice');
  const bob = await createEmployee('bob');
  const { session } = await alice.api.json<{ session: SessionSummary }>('POST', '/sessions', {
    title: '完整事件联调', upstreamHeader: { version: 1, cwd: 'C:\\rufa-test' }, inheritedEventCount: 0,
  });
  const lease = await alice.api.json<{ leaseId: string; nextSeq: number }>('POST', `/sessions/${session.id}/lease`, { deviceId: alice.api.state.deviceId });
  const events = [
    { seq: 0, event: { seq: 0, type: 'turn/start', data: { source: 'user' } } },
    { seq: 1, event: { seq: 1, type: 'tool/call', data: { name: 'read', callId: 'call-1', arguments: { path: 'example.txt' } } } },
    { seq: 2, event: { seq: 2, type: 'tool/result', data: { callId: 'call-1', content: [{ type: 'text', text: '事件原样保存' }] } } },
  ];
  const body = { leaseId: lease.leaseId, expectedNextSeq: 0, events };
  assert.deepEqual(await alice.api.json('POST', `/sessions/${session.id}/events`, body), { nextSeq: 3 });
  assert.deepEqual(await alice.api.json('POST', `/sessions/${session.id}/events`, body), { nextSeq: 3 });
  const recovered = await alice.api.json<{ events: unknown[] }>('GET', `/sessions/${session.id}/events?afterSeq=-1&limit=100`);
  assert.deepEqual(recovered.events, events);
  await assert.rejects(bob.api.json('GET', `/sessions/${session.id}/events`), (e: any) => e.status === 404);
  const reviewed = await manager.json<{ events: unknown[] }>('GET', `/admin/sessions/${session.id}/events`);
  assert.deepEqual(reviewed.events, events);
  await assert.rejects(manager.json('POST', `/sessions/${session.id}/events`, body), (e: any) => e.status === 404);
});

test('本机桥接到公司网关保持native流式与扩展，凭据不透传给上游', async t => {
  const { createEmployee, upstreamRequests } = await fixture(t);
  const { api } = await createEmployee('native-user');
  const bridge = new RuntimeBridge(api);
  await bridge.start();
  t.after(() => bridge.stop());
  const body = {
    model: 'deepseek-flash', stream: true, max_tokens: 32,
    messages: [{ role: 'user', content: [{ type: 'text', text: '测试原生协议' }] }],
    thinking: { type: 'enabled' }, output_config: { effort: 'high' },
    tools: [{ name: 'read', input_schema: { type: 'object' } }],
  };
  const route = `${bridge.origin}/deepseek/anthropic/v1/messages`;
  const denied = await fetch(route, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  assert.equal(denied.status, 401); await denied.body?.cancel();
  const response = await fetch(route, {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'x-api-key': bridge.token, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'mid-conversation-tool-changes-2026-07-01' },
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /跨端联调成功/);
  assert.match(text, /event: message_stop/);
  assert(!text.includes(upstreamKey));
  assert(!text.includes(bridge.token));
  assert.equal(upstreamRequests.length, 1);
  const request = upstreamRequests[0];
  assert.equal(request.path, '/anthropic/v1/messages');
  assert.equal(request.headers['x-api-key'], upstreamKey);
  assert.equal(request.headers['x-rufa-bridge'], undefined);
  assert.equal(request.headers.authorization, undefined);
  assert.deepEqual(request.body.tools, body.tools);
  assert.deepEqual(request.body.thinking, body.thinking);
  assert.deepEqual(request.body.output_config, body.output_config);
  assert.equal(request.body.metadata.user_id, api.state.user!.id);
});

test('SQLite真实文件跨服务重启恢复账号会话，在线备份保持独立一致快照', async t => {
  const { manager, createEmployee, restart, backup } = await fixture(t, true);
  const employee = await createEmployee('persistent-user');
  const { session } = await employee.api.json<{ session: SessionSummary }>('POST', '/sessions', { title: '重启恢复' });
  const lease = await employee.api.json<{ leaseId: string }>('POST', `/sessions/${session.id}/lease`, { deviceId: employee.api.state.deviceId });
  const first = { seq: 0, event: { seq: 0, type: 'message', data: { text: '备份前' } } };
  await employee.api.json('POST', `/sessions/${session.id}/events`, { leaseId: lease.leaseId, expectedNextSeq: 0, events: [first] });
  const backupPath = await backup();
  const second = { seq: 1, event: { seq: 1, type: 'message', data: { text: '备份后' } } };
  await employee.api.json('POST', `/sessions/${session.id}/events`, { leaseId: lease.leaseId, expectedNextSeq: 1, events: [second] });
  await restart();
  assert.equal((await employee.api.verify()).user?.id, employee.user.id);
  await employee.api.refresh();
  const recovered = await employee.api.json<{ events: unknown[] }>('GET', `/sessions/${session.id}/events?afterSeq=-1`);
  assert.deepEqual(recovered.events, [first, second]);
  const reviewed = await manager.json<{ events: unknown[] }>('GET', `/admin/sessions/${session.id}/events?afterSeq=-1`);
  assert.deepEqual(reviewed.events, [first, second]);
  const snapshot = SqliteStore.open(backupPath);
  try {
    assert.equal((await snapshot.findUser('persistent-user'))?.id, employee.user.id);
    assert.equal((await snapshot.getSession(session.id))?.nextSeq, 1);
    assert.deepEqual(await snapshot.readEvents(session.id, -1, 100), [first]);
    assert.equal(snapshot.db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
  } finally { await snapshot.close(); }
});

test('固定原版SessionPersistence经真实客户端桥接保存到SQLite并重新打开', { skip: !process.env.RUFA_RUNTIME_ROOT }, async t => {
  const { manager, createEmployee, clientHome } = await fixture(t);
  const { api } = await createEmployee('original-persistence-user');
  const bridge = new RuntimeBridge(api);
  await bridge.start();
  const keys = ['DSH_HOME', 'RUFA_BRIDGE_ORIGIN', 'RUFA_BRIDGE_TOKEN', 'RUFA_DEVICE_ID'] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { DSH_HOME: clientHome, RUFA_BRIDGE_ORIGIN: bridge.origin, RUFA_BRIDGE_TOKEN: bridge.token, RUFA_DEVICE_ID: api.state.deviceId });
  let ctx: any, service: any;
  try {
    const { importUpstream } = await import('../apps/client/src/runtime/import-upstream.mjs');
    const { Context } = await importUpstream('@deepseek-ai/cordis');
    const { RemotePersistence } = await import('../apps/client/src/runtime/remote-persistence.mjs');
    ctx = new Context();
    service = new RemotePersistence(ctx);
    const header = { id: 'original-runtime-session', version: 4, isSeeded: false, createdAt: Date.now(), cwd: clientHome };
    const events = [
      { type: 'turn/start', seq: 0, time: Date.now(), data: { turn: 1 } },
      { type: 'turn/end', seq: 1, time: Date.now(), data: { turn: 1 } },
      { type: 'session/title', seq: 2, time: Date.now(), data: { title: '办公任务回放', messageSeqs: [], source: { kind: 'user' } } },
    ];
    const writer = await service.create(header);
    await writer.append(events);
    assert.deepEqual((await writer.read()).events, events);
    await writer.close();
    const reader = await service.open(header.id, 'read');
    assert.deepEqual(reader.header, header);
    assert.deepEqual((await reader.read()).events, events);
    await reader.close();
    const stat = await service.stat(header.id);
    assert.equal(stat.eventCount, 3);
    const summaries = await manager.json<{ sessions: SessionSummary[] }>('GET', `/admin/users/${api.state.user!.id}/sessions`);
    assert.equal(summaries.sessions[0].title, '办公任务回放');
    const reviewed = await manager.json<{ events: { seq: number; event: unknown }[] }>('GET', `/admin/sessions/${header.id}/events?afterSeq=-1`);
    assert.deepEqual(reviewed.events.map(record => record.event), events);
    const forkHeader = { ...header, id: 'original-runtime-fork', isSeeded: true, parentSession: header.id };
    const fork = await service.create(forkHeader, { inheritedEventCount: 3 });
    await fork.append(events);
    assert.equal(fork.inheritedEventCount, 3);
    await fork.close();
    assert.equal((await service.list()).length, 2);
  } finally {
    if (service) await Promise.allSettled([...service.handles].map((handle: any) => handle.close()));
    if (ctx) await ctx.fiber.dispose();
    await bridge.stop();
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  }
});

test('管理配置Key只返回状态，员工不可读写，热更新经网关生效且重启保留', async t => {
  const { manager, createEmployee, restart, upstreamRequests } = await fixture(t, true);
  const { api } = await createEmployee('settings-employee');
  const route = '/admin/settings/deepseek';
  const newKey = 'sk-mock-configured-on-server-only-2026';
  await assert.rejects(api.json('GET', route), (e: any) => e.status === 403);
  await assert.rejects(api.json('PUT', route, { apiKey: newKey }), (e: any) => e.status === 403);
  const saved = await manager.json<{ configured: boolean; updatedAt: string }>('PUT', route, { apiKey: newKey });
  assert.deepEqual(Object.keys(saved).sort(), ['configured', 'updatedAt']);
  assert.equal(saved.configured, true);
  assert(Number.isFinite(Date.parse(saved.updatedAt)));
  assert(!JSON.stringify(saved).includes(newKey));
  assert(!JSON.stringify(manager.state).includes(newKey));
  const invoke = async () => {
    const response = await api.authorizedFetch('/gateway/deepseek/anthropic/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-flash', stream: true, max_tokens: 32, messages: [{ role: 'user', content: 'mock only' }] }),
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /跨端联调成功/);
    assert.equal(upstreamRequests.at(-1)!.headers['x-api-key'], newKey);
  };
  await invoke();
  await restart();
  assert.deepEqual(await manager.json('GET', route), saved);
  await invoke();
});
