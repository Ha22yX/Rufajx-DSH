import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, mkdir, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
const event = (seq, text = `完整事件-${seq}`) => ({ type: 'tool/call', seq, time: seq + 2,
  data: { turn: 1, step: 1, callId: `tool-${seq}`, name: 'synthetic', arguments: JSON.stringify({ text }) } });
const header = id => ({ id, version: 4, isSeeded: false, createdAt: 1, cwd: 'C:/synthetic-office' });

test('synchronization fault boundaries preserve complete history', { skip: !process.env.RUFA_RUNTIME_ROOT }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'rufa-sync-faults-'));
  const sessions = new Map(), leases = new Map(), requests = [];
  let intercept;
  const summary = item => ({ id: item.header.id, upstreamHeader: item.header, nextSeq: item.events.length, inheritedEventCount: 0, updatedAt: 'synthetic' });
  const server = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {}, url = new URL(req.url, 'http://127.0.0.1');
      const [, , , id, action] = url.pathname.split('/');
      requests.push({ method: req.method, path: url.pathname, body });
      res.setHeader('content-type', 'application/json');
      if (url.pathname === '/company/sessions' && req.method === 'POST') {
        if (!sessions.has(body.id)) sessions.set(body.id, { header: body.upstreamHeader, events: [] });
        return res.end(JSON.stringify({ session: summary(sessions.get(body.id)) }));
      }
      if (url.pathname === '/company/sessions') return res.end(JSON.stringify({ sessions: [...sessions.values()].map(summary) }));
      const item = sessions.get(id);
      if (!item) { res.statusCode = 404; return res.end('{}'); }
      if (action === 'lease') {
        if (req.method === 'DELETE') { await intercept?.({ req, id, action, body }); if (leases.get(id)?.leaseId === body.leaseId) leases.delete(id); res.statusCode = 204; return res.end(); }
        const lease = { leaseId: leases.get(id)?.leaseId ?? `lease-${id}`, nextSeq: item.events.length, expiresAt: new Date(Date.now() + 120000).toISOString() };
        leases.set(id, lease); await intercept?.({ req, id, action, body }); return res.end(JSON.stringify(lease));
      }
      if (action === 'events') {
        if (req.method === 'GET') {
          const start = Number(url.searchParams.get('afterSeq')) + 1;
          const data = { events: item.events.slice(start, start + Number(url.searchParams.get('limit'))).map(event => ({ seq: event.seq, event })), nextSeq: item.events.length };
          await intercept?.({ req, id, action, body, data }); return res.end(JSON.stringify(data));
        }
        if (leases.get(id)?.leaseId !== body.leaseId) { res.statusCode = 409; return res.end('{}'); }
        assert.equal(body.expectedNextSeq, item.events.length);
        item.events.push(...body.events.map(row => row.event));
        await intercept?.({ req, id, action, body }); return res.end(JSON.stringify({ nextSeq: item.events.length }));
      }
      const data = { session: summary(item) };
      await intercept?.({ req, id, action, body }); res.end(JSON.stringify(data));
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: { code: 'SYNTHETIC_FAILURE' } })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  Object.assign(process.env, { DSH_HOME: home, RUFA_BRIDGE_ORIGIN: `http://127.0.0.1:${server.address().port}`, RUFA_BRIDGE_TOKEN: 'synthetic', RUFA_DEVICE_ID: 'synthetic' });
  const { importUpstream } = await import('../../src/runtime/import-upstream.mjs');
  const { Context } = await importUpstream('@deepseek-ai/cordis');
  const { RemotePersistence } = await import('../../src/runtime/remote-persistence.mjs');
  const ctx = new Context(), service = new RemotePersistence(ctx);
  const seed = (id, rows) => { sessions.set(id, { header: header(id), events: rows }); return sessions.get(id); };
  try {
    await t.test('live callback returns only after an immutable local event is committed', async () => {
      const writer = await service.create(header('live-durable'));
      const held = gate(); writer.enqueueOperation(() => held.promise);
      const row = event(0); writer.enqueueLive(row); row.data.arguments = 'caller mutation';
      try { assert.deepEqual(service.cache.read(writer.id), [event(0)]); }
      finally { held.release(); await writer.close(); }
    });
    await t.test('stale local journal cannot rewind a remote cache or omit a newer durable tail', async () => {
      const id = 'stale-local-journal'; seed(id, [event(0)]);
      service.cache.ensure(header(id)); service.cache.append(id, [event(0), event(1), event(2)]); service.cache.checkpoint(id, 1);
      await writeFile(service.journalPath(id), JSON.stringify({ id, header: header(id), local: true, inheritedEventCount: 0, events: [event(0), event(1)] }));
      const writer = await service.open(id, 'write');
      try {
        assert.equal(service.cache.get(id).cloudState, 'remote');
        assert.equal(writer.nextSeq, 1); assert.deepEqual(writer.pending, [event(1), event(2)]);
        await writer.append([event(3)]); assert.deepEqual(sessions.get(id).events, [0, 1, 2, 3].map(seq => event(seq)));
      } finally { await writer.close(); }
    });
    await t.test('a read opening during promotion cannot restore local state from an old journal', async () => {
      const id = 'read-promotion', writer = await service.create(header(id));
      const original = service.readLocal.bind(service), readStarted = gate(), releaseRead = gate();
      service.readLocal = async sessionId => { const value = await original(sessionId); if (sessionId === id) { readStarted.release(); await releaseRead.promise; } return value; };
      const opening = service.open(id, 'read');
      // Cached read opens are allowed to return immediately without touching the journal.
      await Promise.race([readStarted.promise, opening]);
      await writer.append([{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }]);
      releaseRead.release(); const reader = await opening; service.readLocal = original;
      try { assert.equal(service.cache.get(id).cloudState, 'remote'); assert.equal(service.cache.get(id).syncedSeq, 1); }
      finally { await reader.close(); await writer.close(); }
    });
    await t.test('opening ownership and a catalog pull cannot publish a stale checkpoint after append', async () => {
      const id = 'open-pull-lane'; seed(id, [event(0)]); await service.sync(id);
      const leaseStarted = gate(), releaseLease = gate(), summaryStarted = gate(), releaseSummary = gate();
      let holdLease = true, holdSummary = false, summaryHeld = false;
      intercept = async ({ req, id: requested, action }) => {
        if (requested !== id) return;
        if (action === 'lease' && req.method === 'POST' && holdLease) { holdLease = false; leaseStarted.release(); await releaseLease.promise; }
        if (!action && holdSummary) { holdSummary = false; summaryHeld = true; summaryStarted.release(); await releaseSummary.promise; }
      };
      const opening = service.open(id, 'write'); await leaseStarted.promise;
      holdSummary = true; const syncing = service.sync(id); const observedSync = syncing.catch(error => error);
      // The fixed lane holds the pull behind the pending open. The old code starts it immediately.
      await Promise.race([summaryStarted.promise, new Promise(resolve => setTimeout(resolve, 60))]);
      const racedOpen = summaryHeld;
      releaseLease.release(); const writer = await opening;
      const appending = writer.append([event(1)]);
      // If the pull is ordered first, release it before waiting for append.
      if (racedOpen) await appending;
      releaseSummary.release();
      try { await appending; const result = await observedSync; assert.ok(!(result instanceof Error), result?.message); assert.equal(service.cache.get(id).conflict, null); }
      finally { intercept = undefined; await writer.close(); }
    });
    await t.test('SQLite failure rejects acceptance and execution until the exact retained suffix can be saved', async () => {
      const id = 'sqlite-failure'; seed(id, [event(0)]); const writer = await service.open(id, 'write');
      const append = service.cache.append.bind(service.cache), failure = new Error('synthetic SQLITE_FULL');
      service.cache.append = (sessionId, events) => { if (sessionId === id) throw failure; return append(sessionId, events); };
      const before = requests.length;
      assert.throws(() => writer.enqueueLive(event(1)), error => error === failure);
      assert.throws(() => writer.enqueueLive(event(2)), error => error === failure);
      await assert.rejects(service.ensureWrite(id, { submission: true }), error => error === failure);
      assert.deepEqual(service.cache.read(id), [event(0)]);
      assert.deepEqual(writer.pending, [event(1), event(2)], 'native cleanup events survive repeated disk errors in order');
      assert.equal(requests.length, before, 'failed durability never reaches authorization or model/tool execution');
      service.cache.append = append;
      await writer.flush();
      assert.deepEqual(sessions.get(id).events, [0, 1, 2].map(seq => event(seq))); await writer.close();
    });
    await t.test('real journal write failure preserves SQLite and blocks upload until retry', async () => {
      const id = 'journal-failure'; seed(id, [event(0)]); const writer = await service.open(id, 'write');
      await mkdir(`${writer.journal}.pending`);
      const before = requests.length;
      await assert.rejects(writer.append([event(1)]));
      await assert.rejects(service.ensureWrite(id, { submission: true }));
      assert.deepEqual(service.cache.read(id), [event(0), event(1)]);
      assert.equal(requests.length, before);
      await rmdir(`${writer.journal}.pending`);
      await writer.flush(); assert.deepEqual(sessions.get(id).events, [event(0), event(1)]); await writer.close();
    });
    await t.test('close owns the entire release boundary; concurrent flush joins it and reopen waits for completion', async () => {
      const id = 'close-lane'; seed(id, [event(0)]); const writer = await service.open(id, 'write');
      const deleting = gate(), release = gate();
      intercept = async ({ req, id: requested, action }) => { if (requested === id && action === 'lease' && req.method === 'DELETE') { deleting.release(); await release.promise; } };
      const closing = writer.close(); await deleting.promise;
      assert.throws(() => writer.enqueueLive(event(1)), { name: 'SessionHandleClosedError' });
      await assert.rejects(service.open(id, 'write'), { name: 'SessionAlreadyOwnedError' });
      const flushed = writer.flush(); assert.equal(flushed, closing);
      release.release(); await Promise.all([closing, flushed]); intercept = undefined;
      await assert.rejects(readFile(writer.journal), { code: 'ENOENT' });
      const resumed = await service.open(id, 'write'); await resumed.append([event(1)]); await resumed.close();
      assert.deepEqual(sessions.get(id).events, [event(0), event(1)]);
    });
    await t.test('expired ownership blocks the live handle and a fresh owner recovers an uncommitted suffix', async () => {
      const id = 'expired-owner'; seed(id, [event(0)]); const writer = await service.open(id, 'write');
      writer.accept([event(1)]); writer.lease.expiresAt = new Date(0).toISOString();
      await assert.rejects(writer.flush(), { name: 'SessionOwnershipLostError' });
      await assert.rejects(service.ensureWrite(id, { submission: true }), { name: 'SessionOwnershipLostError' });
      assert.deepEqual(sessions.get(id).events, [event(0)]);
      await writer.close(); leases.delete(id);
      const resumed = await service.open(id, 'write'); assert.deepEqual(resumed.pending, [event(1)]);
      await resumed.flush(); await resumed.close(); assert.deepEqual(sessions.get(id).events, [event(0), event(1)]);
    });
    await t.test('a real two-device fork keeps both server and local bytes and never overwrites either branch', async () => {
      const id = 'true-fork'; seed(id, [event(0)]); const writer = await service.open(id, 'write');
      writer.accept([event(1)]); await writer.journalPending();
      sessions.get(id).events.push(event(1, '另一设备的完整内容'));
      leases.set(id, { leaseId: 'another-login', nextSeq: 2, expiresAt: new Date(Date.now() + 120000).toISOString() });
      await assert.rejects(writer.flush(), { name: 'SessionOwnershipLostError' }); await writer.close();
      const journal = await readFile(writer.journal, 'utf8'), cloud = structuredClone(sessions.get(id).events);
      await assert.rejects(service.open(id, 'write'), /conflict/i);
      assert.equal(service.cache.get(id).conflict, 'EVENT_CONFLICT');
      assert.deepEqual(service.cache.read(id), [event(0), event(1)]);
      assert.equal(await readFile(writer.journal, 'utf8'), journal);
      assert.deepEqual(sessions.get(id).events, cloud);
      assert.equal(service.writers.has(id), false);
    });
    await t.test('inconsistent event pages are rejected without checkpoint advancement and a later valid pull succeeds', async () => {
      const id = 'bad-page'; seed(id, [event(0)]); await service.sync(id); sessions.get(id).events.push(event(1));
      intercept = async ({ id: requested, action, data }) => { if (requested === id && action === 'events' && data) data.nextSeq = 1; };
      await assert.rejects(service.sync(id), /Invalid cloud session event page/);
      assert.equal(service.cache.get(id).syncedSeq, 1); assert.deepEqual(service.cache.read(id), [event(0)]);
      intercept = undefined; await service.sync(id);
      assert.equal(service.cache.get(id).syncedSeq, 2); assert.deepEqual(service.cache.read(id), [event(0), event(1)]);
    });
    await t.test('only an explicit user submission can recover an idle matching live session after lease expiry', async () => {
      const id = 'explicit-recovery'; seed(id, [event(0)]); const writer = await service.open(id, 'write');
      writer.lease.expiresAt = new Date(0).toISOString();
      await assert.rejects(writer.flush(), { name: 'SessionOwnershipLostError' });
      writer.enqueueLive(event(1)); // Native interruption/cleanup still has to be retained.
      await assert.rejects(service.ensureWrite(id, { submission: true }), { name: 'SessionOwnershipLostError' });
      const recoverForUser = async () => ({ header: header(id), events: [event(0), event(1)] });
      const admitted = await service.ensureWrite(id, { submission: true, recoverForUser });
      assert.ok(admitted.leaseId); assert.equal(writer.lostOwnership, false);
      assert.deepEqual(sessions.get(id).events, [event(0), event(1)]);
      await writer.append([event(2)]); await writer.close();
    });
    await t.test('explicit recovery refuses changed native memory, active work and an extra remote tail', async () => {
      const id = 'recovery-refused'; seed(id, [event(0)]); const writer = await service.open(id, 'write');
      writer.lease.expiresAt = new Date(0).toISOString(); await assert.rejects(writer.flush());
      const before = requests.length;
      await assert.rejects(service.ensureWrite(id, { submission: true, recoverForUser: async () => { throw new Error('still running'); } }), /still running/);
      await assert.rejects(service.ensureWrite(id, { submission: true, recoverForUser: async () => ({ header: header(id), events: [] }) }), /状态正在变化/);
      assert.equal(requests.length, before);
      sessions.get(id).events.push(event(1));
      await assert.rejects(service.ensureWrite(id, { submission: true, recoverForUser: async () => ({ header: header(id), events: [event(0)] }) }), /其他设备新增/);
      assert.equal(writer.lostOwnership, true); assert.equal(service.cache.get(id).conflict, null);
      assert.deepEqual(service.cache.read(id), [event(0)]); await writer.close();
    });
    await t.test('legacy advancement marker only clears after explicit submission verifies every overlapping event', async () => {
      const id = 'legacy-marker'; seed(id, [event(0)]); await service.sync(id);
      sessions.get(id).events.push(event(1)); service.cache.conflict(id, 'LIVE_REMOTE_ADVANCED');
      await assert.rejects(service.sync(id)); assert.equal(service.cache.get(id).conflict, 'LIVE_REMOTE_ADVANCED');
      await service.ensureWrite(id, { submission: true, recoverForUser: async () => { throw new Error('cold session has no native memory'); } });
      assert.equal(service.cache.get(id).conflict, null); assert.deepEqual(service.cache.read(id), [event(0), event(1)]);
      const writer = await service.open(id, 'write'); await writer.append([event(2)]); await writer.close();
      for (const reason of ['EVENT_CONFLICT', 'REMOTE_MISSING', 'REMOTE_REWOUND', 'LIVE_REMOTE_ADVANCED']) {
        const bad = `marker-${reason}`; seed(bad, [event(0)]); await service.sync(bad); service.cache.conflict(bad, reason);
        if (reason === 'LIVE_REMOTE_ADVANCED') sessions.get(bad).events[0] = event(0, 'different server history');
        await assert.rejects(service.ensureWrite(bad, { submission: true, recoverForUser: async () => undefined }));
        assert.equal(service.cache.get(bad).conflict, reason); assert.deepEqual(service.cache.read(bad), [event(0)]);
      }
    });
    await t.test('real native publication retains cleanup events after contained disk errors', async () => {
      const { SessionStore } = await importUpstream('@deepseek-ai/dsh-session');
      const nativeCtx = new Context(), store = new SessionStore(nativeCtx);
      const id = 'native-disk-error', native = store.prepare(id, { meta: header(id) });
      const writer = await service.create(native.header), detach = store.enter(native);
      const off = nativeCtx.on('session/event', (_session, value) => writer.enqueueLive(value), { global: true });
      store.announce(native);
      const append = service.cache.append.bind(service.cache), failure = new Error('synthetic full disk');
      service.cache.append = (sessionId, rows) => { if (sessionId === id) throw failure; return append(sessionId, rows); };
      try {
        const first = native.append('turn/start', { turn: 1 });
        const second = native.append('approval/policy', { policy: 'ask' });
        assert.equal(native.seq, 2, 'native observers contain the storage exception');
        assert.deepEqual(writer.pending, [first, second]);
        await assert.rejects(service.ensureWrite(id, { submission: true }), /synthetic full disk/);
        assert.equal(sessions.has(id), false);
        service.cache.append = append; await writer.flush();
        const third = native.append('approval/policy', { policy: 'never' }); await writer.flush();
        assert.deepEqual(sessions.get(id).events, [first, second, third]);
      } finally { service.cache.append = append; off(); detach(); await writer.close(); await nativeCtx.fiber.dispose(); }
    });
    await t.test('user RPC recovery uses real native observations and coalesces duplicate continuation admission', async () => {
      const { SessionStore } = await importUpstream('@deepseek-ai/dsh-session');
      const { SessionQueryEngine } = await importUpstream('@deepseek-ai/dsh-session-query');
      const { attachSessionHistory } = await import('../../src/runtime/company-history.mjs');
      const nativeCtx = new Context(), store = new SessionStore(nativeCtx), query = new SessionQueryEngine(nativeCtx);
      const id = 'native-user-recovery', native = store.prepare(id, { meta: header(id) });
      const writer = await service.create(native.header), detach = store.enter(native);
      const off = nativeCtx.on('session/event', (_session, value) => writer.enqueueLive(value), { global: true });
      store.announce(native);
      native.append('turn/start', { turn: 1 }); await writer.flush();
      writer.lease.expiresAt = new Date(0).toISOString(); await assert.rejects(writer.flush());
      native.append('approval/policy', { policy: 'ask' });
      const agent = { session: native, status: 'running' }, entered = gate(), finish = gate(); let admitted = 0;
      const controller = { promote() {}, history: { async *follow() {} },
        commands: { async prompt() { admitted++; entered.release(); await finish.promise; return { accepted: true }; } },
        listState: { list: async () => [], summaryFor() {}, summarizeCold() {} }, controlState: { broadcast() {} } };
      const context = { sessions: store, sessionQuery: query, agents: { get: () => agent }, emit() {} };
      const dispose = attachSessionHistory(context, controller, service);
      const request = { sessionId: id, requestId: 'synthetic-continuation', mode: 'queue', content: [{ type: 'text', text: '继续核对当前状态' }] };
      const source = { kind: 'user', rpcId: request.requestId };
      try {
        await assert.rejects(controller.commands.prompt(request, source), /等待当前任务停止/); assert.equal(admitted, 0);
        agent.status = 'idle';
        const first = controller.commands.prompt(request, source), duplicate = controller.commands.prompt(structuredClone(request), structuredClone(source));
        await entered.promise;
        await assert.rejects(controller.commands.prompt({ ...request, content: [{ type: 'text', text: 'different' }] }, source), /重复提交的内容不一致/);
        assert.equal(admitted, 1); assert.equal(writer.lostOwnership, false);
        assert.equal(sessions.get(id).events.length, native.seq);
        finish.release(); assert.deepEqual(await first, { accepted: true }); assert.deepEqual(await duplicate, { accepted: true });
      } finally { finish.release(); dispose(); off(); detach(); await writer.close(); await nativeCtx.fiber.dispose(); }
    });
    t.diagnostic(`Independent account / SQLite fault evidence: ${home}; no real account or model calls.`);
  } finally {
    intercept = undefined;
    await Promise.allSettled([...service.handles].map(handle => handle.close()));
    await service.stopBackground(); service.cache.close(); await ctx.fiber.dispose();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
