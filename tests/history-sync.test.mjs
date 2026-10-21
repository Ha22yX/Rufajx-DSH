// Real company HTTP + bridge + SQLite + pinned Harness persistence; no model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../apps/server/dist/app.js';
import { configFromEnv } from '../apps/server/dist/config.js';
import { SqliteStore } from '../apps/server/dist/sqlite-store.js';
import { hashPassword } from '../apps/server/dist/security.js';
import { CompanyApi } from '../apps/client/dist/company-api.js';
import { RuntimeBridge } from '../apps/client/dist/runtime-bridge.js';

class Vault { async read() { return null; } async write() {} async clear() {} }
test('account-local complete history synchronizes both ways through the real authorized company service', { skip: !process.env.RUFA_RUNTIME_ROOT, timeout: 60000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rufa-real-history-'));
  const store = SqliteStore.open(join(directory, 'company.sqlite'));
  const password = 'Synthetic-only-history-2026';
  await store.createUser({ username: 'alpha', displayName: 'Alpha', role: 'admin', passwordHash: await hashPassword(password) }, true);
  await store.createUser({ username: 'bravo', displayName: 'Bravo', role: 'employee', passwordHash: await hashPassword(password) });
  const server = buildApp(store, configFromEnv({}), () => store.ping());
  const url = await server.listen({ host: '127.0.0.1', port: 0 });
  let offline = false, requests = 0, gatewayRequests = 0;
  const request = async (...args) => {
    requests++;
    if (String(args[0]).includes('/gateway/')) { gatewayRequests++; throw new Error('Paid model routes are forbidden in this test'); }
    if (offline) throw new Error('Synthetic disconnected network');
    return fetch(...args);
  };
  const api = new CompanyApi(new Vault(), true, request), other = new CompanyApi(new Vault(), true);
  await api.login(url, 'alpha', password); await other.login(url, 'alpha', password);
  const bridge = new RuntimeBridge(api); await bridge.start();
  Object.assign(process.env, { RUFA_BRIDGE_ORIGIN: bridge.origin, RUFA_BRIDGE_TOKEN: bridge.token, RUFA_DEVICE_ID: api.state.deviceId });
  const { importUpstream } = await import('../apps/client/src/runtime/import-upstream.mjs');
  const { Context } = await importUpstream('@deepseek-ai/cordis');
  const { Session, appendPluginRecord } = await importUpstream('@deepseek-ai/dsh-session');
  const { createUserMessage } = await importUpstream('@deepseek-ai/dsh-llm');
  const { RemotePersistence } = await import('../apps/client/src/runtime/remote-persistence.mjs');
  const contexts = [], services = [];
  function create(home) {
    process.env.DSH_HOME = join(directory, home);
    const ctx = new Context(), service = new RemotePersistence(ctx);
    contexts.push(ctx); services.push(service); return service;
  }
  async function dispose(service) {
    await service.stopBackground();
    await Promise.allSettled([...service.handles].map(handle => handle.close()));
    service.cache.close(); services.splice(services.indexOf(service), 1);
  }
  let local = create('alpha');
  const header = { id: 'history-real', version: 4, createdAt: Date.now(), cwd: 'C:/Synthetic-office', isSeeded: false };
  const native = Session.create(header.id, undefined, header);
  try {
    await t.test('repeated empty sessions remain local; the first real message uploads the exact prefix', async () => {
      const before = requests;
      for (let index = 0; index < 3; index++) {
        const blank = await local.create({ ...header, id: `blank-${index}` });
        await blank.flush(); await blank.close();
      }
      const writer = await local.create(header);
      const initial = native.append('permission/preset', { preset: 'auto' });
      await writer.append([initial]); await writer.flush();
      assert.equal(requests, before);
      assert.equal((await api.json('GET', '/sessions')).sessions.length, 0);
      const message = createUserMessage({ content: [{ type: 'text', text: 'Synthetic full history test' }], source: { kind: 'user' } });
      const submitted = native.append('user/message', message, { surfaceOp: 'append' });
      await writer.append([submitted]); await writer.close();
      const cloud = await api.json('GET', '/sessions');
      assert.equal(cloud.sessions.length, 1);
      assert.deepEqual((await api.json('GET', `/sessions/${header.id}/events`)).events.map(row => row.event), native.snapshotEvents());
    });
    await t.test('local tool call/result metadata and more than one page survive upload and restart', async () => {
      const writer = await local.open(header.id, 'write');
      const start = native.seq;
      native.append('tool/call', { turn: 1, step: 1, callId: 'call-office', name: 'create_spreadsheet', arguments: '{"file":"report.xlsx"}' });
      native.append('tool/result', { turn: 1, step: 1, message: { id: 'tool-office-result', role: 'tool', source: { kind: 'tool', callId: 'call-office' }, toolCallId: 'call-office', content: [{ type: 'text', text: 'Synthetic result, no file execution.' }] }, meta: { file: 'report.xlsx', rows: 20 } }, { surfaceOp: 'append' });
      for (let index = 0; index < 600; index++) appendPluginRecord(native, 'plugin:rufa/history-test', { index, nested: { exact: true } });
      await writer.append(native.snapshotEvents(start)); await writer.close();
      const expected = native.snapshotEvents();
      await dispose(local); local = create('alpha');
      offline = true;
      const began = performance.now(), reader = await local.open(header.id, 'read');
      assert.deepEqual((await reader.read()).events, expected);
      assert((await local.list()).some(row => row.header.id === header.id));
      assert(performance.now() - began < 500, 'Cached reads must not wait for network failure/timeout');
      await reader.close(); offline = false;
    });
    await t.test('another device adds a remote tail; incremental pull keeps exact timestamps and tool records', async () => {
      const notifications = []; const unsubscribe = local.onRemoteChange(change => notifications.push(change));
      const previous = native.seq;
      const tail = native.append('session/title', { title: 'Cross-device title', messageSeqs: [1], source: { kind: 'user' } });
      const lease = await other.json('POST', `/sessions/${header.id}/lease`, { deviceId: other.state.deviceId });
      await other.json('POST', `/sessions/${header.id}/events`, { leaseId: lease.leaseId, expectedNextSeq: previous, events: [{ seq: tail.seq, event: tail }] });
      await other.json('DELETE', `/sessions/${header.id}/lease`, { leaseId: lease.leaseId });
      await local.sync(header.id);
      assert.deepEqual(local.readCached(header.id).events, native.snapshotEvents());
      assert(notifications.some(change => change.events.some(row => row.seq === tail.seq && row.time === tail.time)));
      unsubscribe();
    });
    await t.test('another active device owns the writer; cached history stays readable but local execution admission fails', async () => {
      const lease = await other.json('POST', `/sessions/${header.id}/lease`, { deviceId: other.state.deviceId });
      const reader = await local.open(header.id, 'read');
      assert.deepEqual((await reader.read()).events, native.snapshotEvents());
      await assert.rejects(local.open(header.id, 'write'));
      await reader.close();
      await other.json('DELETE', `/sessions/${header.id}/lease`, { leaseId: lease.leaseId });
    });
    await t.test('different accounts have separate cache databases and the server rejects cross-account access', async () => {
      await dispose(local); local = undefined;
      await api.logout(); await api.login(url, 'bravo', password);
      process.env.RUFA_DEVICE_ID = api.state.deviceId;
      const bravo = create('bravo');
      assert.equal(bravo.readCached(header.id), undefined);
      assert.equal((await bravo.list()).length, 0);
      await assert.rejects(bravo.open(header.id, 'read'));
      const blank = await bravo.create({ ...header, id: 'bravo-blank' }); await blank.close();
      assert.equal(bravo.cache.list().length, 1);
      await dispose(bravo);
    });
    assert.equal(gatewayRequests, 0);
  } finally {
    offline = false;
    for (const service of [...services]) await dispose(service);
    for (const ctx of contexts) await ctx.fiber.dispose();
    await bridge.stop(); await server.close(); await store.close();
  }
});
