import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('complete account history cache, incremental synchronization and admission', { skip: !process.env.RUFA_RUNTIME_ROOT }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'rufa-full-cache-'));
  const rows = new Map(), leases = new Map(), requests = [], readers = [], rejectedEvents = new Set(), rejectedLeases = new Set();
  let held = false, rejectLease = false, brokenPagination = false;
  const releaseReads = () => { held = false; for (const release of readers.splice(0)) release(); };
  const header = id => ({ id, version: 4, isSeeded: false, createdAt: 10, cwd: 'C:/synthetic-office' });
  const event = seq => ({ type: 'tool/call', seq, time: 20 + seq,
    data: { turn: 1, step: 1, callId: `synthetic-${seq}`, name: 'synthetic_office_tool', arguments: JSON.stringify({ index: seq, text: '完整工具参数' }) } });
  const summary = row => ({ id: row.id, upstreamHeader: row.header, inheritedEventCount: row.inheritedEventCount ?? 0,
    nextSeq: row.events.length, updatedAt: String(row.events.length) });
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.headers['x-rufa-bridge'], 'cache-test');
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {}, url = new URL(req.url, 'http://127.0.0.1');
      requests.push({ method: req.method, url: url.pathname + url.search });
      if (held && req.method === 'GET') await new Promise(resolve => readers.push(resolve));
      res.setHeader('content-type', 'application/json');
      if (url.pathname === '/company/sessions' && req.method === 'POST') {
        if (!rows.has(body.id)) rows.set(body.id, { id: body.id, header: body.upstreamHeader, inheritedEventCount: body.inheritedEventCount, events: [] });
        return res.end(JSON.stringify({ session: summary(rows.get(body.id)) }));
      }
      if (url.pathname === '/company/sessions') {
        if (brokenPagination && url.searchParams.has('cursor')) { res.statusCode = 503; return res.end('{}'); }
        return res.end(JSON.stringify({ sessions: [...rows.values()].map(summary), ...(brokenPagination ? { nextCursor: 'page-two' } : {}) }));
      }
      const [, , , id, action] = url.pathname.split('/'), row = rows.get(id);
      if (!row) { res.statusCode = 404; return res.end('{}'); }
      if (action === 'lease') {
        if (req.method === 'DELETE') { leases.delete(id); res.statusCode = 204; return res.end(); }
        if (rejectLease || rejectedLeases.has(id)) { res.statusCode = 403; return res.end('{}'); }
        const lease = { leaseId: leases.get(id)?.leaseId ?? `lease-${id}`, nextSeq: row.events.length,
          expiresAt: new Date(Date.now() + 120000).toISOString() };
        leases.set(id, lease); return res.end(JSON.stringify(lease));
      }
      if (action === 'events') {
        if (req.method === 'GET') {
          const offset = Number(url.searchParams.get('afterSeq')) + 1, limit = Number(url.searchParams.get('limit'));
          return res.end(JSON.stringify({ events: row.events.slice(offset, offset + limit).map(event => ({ seq: event.seq, event })), nextSeq: row.events.length }));
        }
        if (body.leaseId !== leases.get(id)?.leaseId) { res.statusCode = 409; return res.end('{}'); }
        if (rejectedEvents.has(id)) { res.statusCode = 503; return res.end('{}'); }
        assert.equal(body.expectedNextSeq, row.events.length);
        row.events.push(...body.events.map(record => record.event)); return res.end(JSON.stringify({ nextSeq: row.events.length }));
      }
      return res.end(JSON.stringify({ session: summary(row) }));
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: { code: 'TEST_FAILURE' } })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  Object.assign(process.env, { DSH_HOME: home, RUFA_BRIDGE_ORIGIN: `http://127.0.0.1:${server.address().port}`,
    RUFA_BRIDGE_TOKEN: 'cache-test', RUFA_DEVICE_ID: 'cache-device' });
  const { importUpstream } = await import('../../dist/runtime/import-upstream.mjs');
  const { Context } = await importUpstream('@deepseek-ai/cordis');
  const { RemotePersistence } = await import('../../dist/runtime/remote-persistence.mjs');
  const { SessionCache } = await import('../../dist/runtime/session-cache.mjs');
  const ctx = new Context(), service = new RemotePersistence(ctx);
  const deadline = async promise => {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Cached path waited for blocked network')), 500); })]); }
    finally { clearTimeout(timer); }
  };
  try {
    await t.test('cold download stores all pages and tool events, later synchronization fetches only the tail', async () => {
      const events = Array.from({ length: 1103 }, (_, seq) => event(seq));
      rows.set('history', { id: 'history', header: header('history'), events });
      const changes = []; const off = service.onRemoteChange(change => { changes.push(change); });
      await service.sync('history');
      assert.deepEqual(service.readCached('history').events, events);
      assert.equal(changes[0].events.length, 1103);
      assert.equal(requests.filter(row => row.url.includes('/history/events')).length, 3);
      const count = requests.length; events.push(event(1103), event(1104));
      await service.sync('history');
      assert.deepEqual(changes[1].events, events.slice(1103));
      const tailReads = requests.slice(count).filter(row => row.url.includes('/history/events'));
      assert.equal(tailReads.length, 1); assert.match(tailReads[0].url, /afterSeq=1102/);
      assert.equal(service.readCached('history').eventCount, 1105);
      off();
    });
    await t.test('a reopened account lists and reads its complete cached history while all cloud reads are blocked', async () => {
      held = true;
      const restartCtx = new Context(), restart = new RemotePersistence(restartCtx);
      try {
        const reader = await deadline(restart.open('history', 'read'));
        assert.equal((await deadline(reader.read())).events.length, 1105);
        assert.equal((await deadline(restart.stat('history'))).eventCount, 1105);
        assert.equal((await deadline(restart.list())).find(row => row.header.id === 'history').eventCount, 1105);
        assert.equal(leases.size, 0); await reader.close();
      } finally { releaseReads(); await restart.stopBackground(); restart.cache.close(); await restartCtx.fiber.dispose(); }
    });
    await t.test('failed native update notification is retried without downloading the complete log', async () => {
      let fail = true; const changes = [];
      const off = service.onRemoteChange(change => { changes.push(change); if (fail) { fail = false; throw new Error('synthetic UI delay'); } });
      rows.get('history').events.push(event(1105));
      await assert.rejects(service.sync('history'), /synthetic UI delay/);
      const count = requests.length; await service.sync('history');
      assert.equal(changes.length, 2); assert.equal(changes[1].events[0].seq, 1105);
      assert.equal(requests.slice(count).filter(row => row.url.includes('/history/events')).length, 0);
      off();
    });
    await t.test('another server/account directory cannot see this account cache', async () => {
      const another = new SessionCache(await mkdtemp(join(tmpdir(), 'rufa-other-account-')));
      try { assert.equal(another.get('history'), undefined); assert.deepEqual(another.list(), []); }
      finally { another.close(); }
    });
    await t.test('cache conflicts roll back a whole event batch and preserve tool records', () => {
      const before = service.readCached('history').events;
      assert.throws(() => service.cache.append('history', [{ ...event(0), data: { changed: true } }, event(1106)]), /conflict/);
      assert.deepEqual(service.readCached('history').events, before);
    });
    await t.test('a confirmed deleted initialization-only cloud record becomes local and is not recreated on close', async () => {
      const initial = { type: 'approval/policy', seq: 0, time: 20, data: { policy: 'ask' } };
      rows.set('cleaned-blank', { id: 'cleaned-blank', header: header('cleaned-blank'), events: [initial, { type: 'session/end-seed', seq: 1, time: 21, data: {} }] });
      await service.sync('cleaned-blank'); rows.delete('cleaned-blank');
      await service.sync('cleaned-blank'); assert.equal(service.readCached('cleaned-blank').cloudState, 'local');
      const count = requests.length, writer = await service.open('cleaned-blank', 'write');
      await service.ensureWrite(writer.id, { submission: false }); await writer.flush(); await writer.close();
      assert.equal(requests.length, count); assert.equal(rows.has('cleaned-blank'), false);
    });
    await t.test('unknown initialization fields and inherited restore markers are never demoted after a 404', async () => {
      for (const [id, initial] of [
        ['unknown-initial', { type: 'approval/policy', seq: 0, time: 20, data: { policy: 'ask', note: 'preserve unknown content' } }],
        ['inherited-marker', { type: 'session/end-seed', seq: 0, time: 20, data: { inherited: true } }],
      ]) {
        rows.set(id, { id, header: header(id), events: [initial] });
        await service.sync(id); rows.delete(id);
        await assert.rejects(service.sync(id), /本地完整记录/);
        assert.equal(service.readCached(id).conflict, 'REMOTE_MISSING');
        assert.deepEqual(service.readCached(id).events, [initial]);
      }
    });
    await t.test('missing meaningful cloud history and incomplete pagination never erase local data', async () => {
      rows.set('missing-content', { id: 'missing-content', header: header('missing-content'), events: [event(0)] });
      await service.sync('missing-content'); rows.delete('missing-content');
      await assert.rejects(service.sync('missing-content'), /本地完整记录/);
      assert.equal(service.readCached('missing-content').events.length, 1);
      const before = service.cache.list().map(row => row.id).sort();
      brokenPagination = true; await assert.rejects(service.sync()); brokenPagination = false;
      assert.deepEqual(service.cache.list().map(row => row.id).sort(), before);
    });
    await t.test('restart retries durable submitted content without an agent; blank and inherited-only records stay local', async () => {
      const first = { type: 'turn/start', seq: 0, time: 20, data: { turn: 1 } };
      const writer = await service.create(header('restart-pending'));
      rejectedEvents.add(writer.id);
      await assert.rejects(writer.append([first]));
      // A process stopped after its durable save but before cloud commit.
      clearInterval(writer.heartbeat); clearTimeout(writer.timer); writer.closed = true;
      service.writers.delete(writer.id); service.handles.delete(writer); leases.delete(writer.id);
      const blank = await service.create(header('restart-blank')); await blank.close();
      const fork = await service.create({ ...header('restart-fork'), isSeeded: true }, { inheritedEventCount: 1 });
      await fork.append([first]); await fork.close();
      rejectedEvents.delete(writer.id);
      const restartedCtx = new Context(), restarted = new RemotePersistence(restartedCtx);
      try {
        await restarted.sync();
        assert.deepEqual(rows.get(writer.id).events, [first]);
        assert.equal(restarted.readCached(writer.id).syncedSeq, 1);
        assert.equal(rows.has(blank.id), false); assert.equal(rows.has(fork.id), false);
        assert.equal(restarted.writers.size, 0); assert.equal(leases.size, 0);
      } finally { await restarted.stopBackground(); restarted.cache.close(); await restartedCtx.fiber.dispose(); }
    });
    await t.test('a rejected pending lease does not prevent another pending upload or another remote tail download', async () => {
      const busyId = 'busy-pending';
      rows.set(busyId, { id: busyId, header: header(busyId), events: [] });
      await service.sync(busyId); service.cache.append(busyId, [{ type: 'turn/start', seq: 0, time: 20, data: { turn: 1 } }]);
      rejectedLeases.add(busyId);
      const local = await service.create(header('other-pending'));
      local.accept([{ type: 'turn/start', seq: 0, time: 20, data: { turn: 1 } }]);
      await local.journalPending();
      const expected = event(1106); rows.get('history').events.push(expected);
      try {
        await assert.rejects(service.sync(), { name: 'AggregateError' });
        assert.equal(rows.get(local.id).events.length, 1);
        assert.deepEqual(service.readCached('history').events.at(-1), expected);
        assert.equal(service.readCached(busyId).eventCount, 1);
        assert.equal(service.readCached(busyId).syncedSeq, 0);
        assert.equal(service.writers.has(busyId), false);
      } finally { rejectedLeases.delete(busyId); await local.close(); }
      await service.sync(); assert.equal(rows.get(busyId).events.length, 1);
    });
    await t.test('only an explicit submission promotes an existing local writer; revoked leases block execution', async () => {
      const writer = await service.create(header('admission'));
      await service.ensureWrite(writer.id); assert.equal(rows.has(writer.id), false);
      const authorized = await service.ensureWrite(writer.id, { submission: true });
      assert(authorized.leaseId); assert.equal(rows.get(writer.id).events.length, 0);
      rejectLease = true;
      await assert.rejects(service.ensureWrite(writer.id, { submission: true }), { name: 'SessionOwnershipLostError' });
      rejectLease = false; await writer.close(); leases.delete(writer.id);
    });
    await t.test('unexpected cloud tail invalidates the live owner but remains recoverable after closing it', async () => {
      const writer = await service.create(header('live-conflict'));
      await writer.append([{ type: 'turn/start', seq: 0, time: 20, data: { turn: 1 } }]);
      rows.get(writer.id).events.push(event(1));
      await assert.rejects(service.sync(writer.id), { name: 'SessionOwnershipLostError' });
      await assert.rejects(service.ensureWrite(writer.id, { submission: true }), { name: 'SessionOwnershipLostError' });
      assert.throws(() => writer.flush(), { name: 'SessionOwnershipLostError' });
      assert.equal(service.readCached(writer.id).events.length, 1);
      assert.equal(service.readCached(writer.id).conflict, null);
      await writer.close();
      const reopened = await service.open(writer.id, 'write');
      assert.deepEqual((await reopened.read()).events, rows.get(writer.id).events);
      await reopened.append([event(2)]); await reopened.close();
    });
  } finally {
    releaseReads(); rejectLease = false; brokenPagination = false;
    await service.stopBackground(); await Promise.allSettled([...service.handles].map(handle => handle.close()));
    service.cache.close(); await ctx.fiber.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
