import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('real upstream persistence adapter preserves events, recovery, fork metadata and lease lifecycle', { skip: !process.env.RUFA_RUNTIME_ROOT }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'rufa-persistence-test-'));
  const sessions = new Map(); const leases = new Map(); const requests = [];
  let unavailable = false; let createUnavailable = false; let loseCreateResponse = false; let loseAppendResponse = false;
  let changeAtLease = false; let leaseOrdinal = 0;
  const event = seq => ({ type: 'turn/start', seq, time: Date.now(), data: { turn: seq + 1 } });
  const summary = item => ({ ...item, events: undefined, nextSeq: item.events.length });
  const company = createServer(async (req, res) => {
    try {
      assert.equal(req.headers['x-rufa-bridge'], 'test-bridge');
      let raw = ''; for await (const chunk of req) raw += chunk; const body = raw ? JSON.parse(raw) : {};
      res.setHeader('content-type', 'application/json');
      const url = new URL(req.url, 'http://127.0.0.1'); const parts = url.pathname.split('/'); const id = parts[3]; const action = parts[4];
      requests.push({ method: req.method, path: url.pathname });
      if (req.method === 'POST' && url.pathname === '/company/sessions') {
        if (createUnavailable) { res.statusCode = 503; return res.end('{}'); }
        let item = sessions.get(body.id);
        if (item) { assert.deepEqual(item.upstreamHeader, body.upstreamHeader); assert.equal(item.inheritedEventCount, body.inheritedEventCount); }
        else { item = { ...body, ownerId: 'employee', title: 'test', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), events: [] }; sessions.set(item.id, item); }
        if (loseCreateResponse) { loseCreateResponse = false; req.socket.destroy(); return; }
        return res.end(JSON.stringify({ session: summary(item) }));
      }
      if (url.pathname === '/company/sessions') return res.end(JSON.stringify({ sessions: [...sessions.values()].map(summary) }));
      const item = sessions.get(id); if (!item) { res.statusCode = 404; return res.end('{}'); }
      if (action === 'lease') {
        if (req.method === 'DELETE') { if (leases.get(id)?.leaseId === body.leaseId) leases.delete(id); res.statusCode = 204; return res.end(); }
        if (changeAtLease) { item.events.push(event(item.events.length)); changeAtLease = false; }
        const lease = { leaseId: leases.get(id)?.leaseId ?? `lease-${++leaseOrdinal}`, nextSeq: item.events.length, expiresAt: new Date(Date.now() + 120_000).toISOString() };
        leases.set(id, lease); return res.end(JSON.stringify(lease));
      }
      if (action === 'events') {
        if (req.method === 'GET') {
          const after = Number(url.searchParams.get('afterSeq')); const limit = Number(url.searchParams.get('limit'));
          return res.end(JSON.stringify({ events: item.events.slice(after + 1, after + 1 + limit).map(event => ({ seq: event.seq, event })), nextSeq: item.events.length }));
        }
        if (unavailable) { res.statusCode = 503; return res.end('{}'); }
        if (leases.get(id)?.leaseId !== body.leaseId) { res.statusCode = 409; return res.end(JSON.stringify({ error: { code: 'LEASE_LOST' } })); }
        if (body.expectedNextSeq < item.events.length) {
          assert.deepEqual(item.events.slice(body.expectedNextSeq, body.expectedNextSeq + body.events.length), body.events.map(record => record.event));
          return res.end(JSON.stringify({ nextSeq: item.events.length }));
        }
        if (body.expectedNextSeq !== item.events.length) { res.statusCode = 409; return res.end('{}'); }
        item.events.push(...body.events.map(record => record.event));
        if (loseAppendResponse) { loseAppendResponse = false; req.socket.destroy(); return; }
        return res.end(JSON.stringify({ nextSeq: item.events.length }));
      }
      res.end(JSON.stringify({ session: summary(item) }));
    } catch { res.statusCode = 500; res.end('{}'); }
  });
  await new Promise(resolve => company.listen(0, '127.0.0.1', resolve));
  Object.assign(process.env, { DSH_HOME: home, RUFA_BRIDGE_ORIGIN: `http://127.0.0.1:${company.address().port}`, RUFA_BRIDGE_TOKEN: 'test-bridge', RUFA_DEVICE_ID: 'test-device' });
  const { importUpstream } = await import('../../dist/runtime/import-upstream.mjs');
  const { Context } = await importUpstream('@deepseek-ai/cordis');
  const plugin = await import('../../dist/runtime/remote-persistence.mjs');
  const { RemotePersistence } = plugin;
  const ctx = new Context(); const service = new RemotePersistence(ctx);
  const header = id => ({ id, version: 4, isSeeded: false, createdAt: Date.now(), cwd: 'C:/office' });
  const title = (seq, value = 'local title') => ({ type: 'session/title', seq, time: Date.now(), data: { title: value, messageSeqs: [], source: { kind: 'user' } } });
  try {
    await t.test('new empty sessions, metadata, reads, flush and close stay durable locally without network', async () => {
      const before = requests.length; createUnavailable = true;
      const handle = await service.create(header('local-only')); const originalHeader = handle.header;
      await handle.append([title(0)]); await handle.flush(); await service.flush(); await handle.renew();
      assert.deepEqual((await handle.read()).events, [title(0, 'local title')].map(row => ({ ...row, time: handle.pending[0].time })));
      const reader = await service.open('local-only', 'read');
      assert.equal((await reader.read()).events.length, 1); assert.equal((await service.stat('local-only')).eventCount, 1);
      assert(Object.isFrozen((await reader.read()).events[0]));
      await reader.close(); await handle.close();
      assert.equal(requests.length, before); assert.equal(sessions.has('local-only'), false); assert.equal(leases.size, 0);
      const reopened = await service.open('local-only', 'write'); assert.deepEqual(reopened.header, originalHeader);
      assert.equal((await reopened.read()).events[0].data.title, 'local title'); await reopened.close();
      assert.equal(requests.length, before);
      await assert.rejects(service.create(originalHeader), { name: 'SessionAlreadyExistsError' });
      assert((await service.list()).some(row => row.header.id === 'local-only' && row.eventCount === 1));
      createUnavailable = false;
    });
    await t.test('a local read handle follows first-send promotion and preserves the metadata prefix', async () => {
      const handle = await service.create(header('first-send')); const metadata = title(0); await handle.append([metadata]);
      const reader = await service.open('first-send', 'read'); const sent = event(1);
      assert.equal(sessions.has('first-send'), false); await handle.append([sent]);
      assert.deepEqual(sessions.get('first-send').events, [metadata, sent]);
      assert.deepEqual((await reader.read()).events, [metadata, sent]);
      assert.equal((await service.list()).filter(row => row.header.id === 'first-send').length, 1);
      await reader.close(); await handle.close();
    });
    await t.test('append/read/fork metadata and strict sequence validation', async () => {
      const handle = await service.create(header('one')); const row = event(0);
      await handle.append([row]); assert.deepEqual((await handle.read()).events, [row]);
      assert.equal((await handle.read()).eventState, 'shared-frozen');
      assert.throws(() => handle.append([event(3)]), /Non-contiguous/);
      await assert.rejects(service.open('one', 'write'), { name: 'SessionAlreadyOwnedError' });
      const reader = await service.open('one', 'read'); assert.throws(() => reader.append([]), { name: 'SessionReadOnlyError' });
      await reader.close(); await handle.close(); assert.equal(leases.size, 0);
      const fork = await service.create({ ...header('fork'), isSeeded: true, parentSession: 'one' }, { inheritedEventCount: 1 });
      await fork.append([row]); assert.equal(fork.inheritedEventCount, 1); assert.equal(sessions.has('fork'), false); await fork.close();
      const forkResumed = await service.open('fork', 'write'); assert.equal(forkResumed.inheritedEventCount, 1);
      await forkResumed.append([event(1)]); assert.equal(sessions.get('fork').inheritedEventCount, 1);
      assert.deepEqual(sessions.get('fork').events[0], row); await forkResumed.close();
      await assert.rejects(service.create({ ...header('badfork'), isSeeded: true }), /fork inheritance/);
    });
    await t.test('lost create response and lost append response retry without duplicate sessions or events', async () => {
      const handle = await service.create(header('ambiguous')); const first = event(0);
      loseCreateResponse = true; await assert.rejects(handle.append([first]));
      assert.equal(sessions.get('ambiguous').events.length, 0);
      assert.equal(JSON.parse(await readFile(join(home, 'company-pending-events/ambiguous.json'))).local, true);
      loseAppendResponse = true; await assert.rejects(handle.flush());
      assert.deepEqual(sessions.get('ambiguous').events, [first]);
      const second = event(1); await handle.append([second]);
      assert.deepEqual(sessions.get('ambiguous').events, [first, second]); await handle.close();
    });
    await t.test('restart restores local unsent sessions and resumes an interrupted promotion with a verified prefix', async () => {
      const h = header('restart-local'); const metadata = title(0); const sent = event(1); const later = event(2);
      const local = await service.create(h); await local.append([metadata]); await local.close();
      const recordPath = join(home, 'company-pending-events/restart-local.json');
      const interrupted = JSON.parse(await readFile(recordPath));
      interrupted.events.push(sent, later); interrupted.uploadRequested = true;
      await writeFile(recordPath, JSON.stringify(interrupted));
      sessions.set(h.id, { id: h.id, upstreamHeader: h, inheritedEventCount: 0, nextSeq: 2, updatedAt: 'test', events: [metadata, sent] });
      const nextCtx = new Context(); const nextService = new RemotePersistence(nextCtx);
      try {
        const before = requests.length; const resumed = await nextService.open(h.id, 'write');
        assert.equal(requests.length, before); assert.deepEqual(resumed.header, h);
        await resumed.flush(); assert.deepEqual(sessions.get(h.id).events, [metadata, sent, later]);
        await resumed.close();
      } finally { await nextCtx.fiber.dispose(); }
    });
    await t.test('network failures retain pending events and retry without rewriting accepted history', async () => {
      const handle = await service.open('one', 'write'); const next = event(1); unavailable = true;
      await assert.rejects(handle.append([next])); assert.equal(sessions.get('one').events.length, 1);
      const journal = JSON.parse(await readFile(join(home, 'company-pending-events/one.json'))); assert.deepEqual(journal.events, [next]);
      unavailable = false; await handle.flush(); assert.equal(sessions.get('one').events.length, 2); await handle.close();
      const ambiguous = [sessions.get('one').events[1], event(2)];
      await writeFile(join(home, 'company-pending-events/one.json'), JSON.stringify({ id: 'one', events: ambiguous }));
      const recovered = await service.open('one', 'write'); await recovered.flush(); assert.equal(sessions.get('one').events.length, 3); await recovered.close();
    });
    await t.test('lease acquisition refreshes a stale summary before append', async () => {
      changeAtLease = true; const handle = await service.open('one', 'write');
      assert.equal(handle.nextSeq, 4); await handle.append([event(4)]); await handle.close();
    });
    await t.test('corrupt recovery releases acquired ownership and handle resources', async () => {
      await mkdir(join(home, 'company-pending-events'), { recursive: true });
      await writeFile(join(home, 'company-pending-events/one.json'), '{corrupt');
      await assert.rejects(service.open('one', 'write'));
      assert.equal(leases.size, 0); assert.equal(service.handles.size, 0); assert.equal(service.writers.size, 0);
    });
    await t.test('lost lease cannot silently re-acquire ownership', async () => {
      const handle = await service.create(header('lost')); await handle.append([event(0)]); leases.delete('lost');
      await assert.rejects(handle.append([event(1)]), { name: 'SessionOwnershipLostError' });
      assert.throws(() => handle.flush(), { name: 'SessionOwnershipLostError' });
      await handle.close(); assert.equal(service.writers.size, 0);
      assert.equal(JSON.parse(await readFile(join(home, 'company-pending-events/lost.json'))).events.length, 1);
    });
    await t.test('unloading the actual Cordis plugin flushes live events and releases leases', async () => {
      const mounted = new Context(); const fiber = mounted.plugin(plugin); await fiber.await();
      await mounted.sessionPersistence.create(header('lifecycle'));
      mounted.emit('session/event', { id: 'lifecycle' }, event(0));
      await fiber.dispose();
      assert.equal(sessions.get('lifecycle').events.length, 1); assert.equal(leases.has('lifecycle'), false);
      await mounted.fiber.dispose();
    });
    await t.test('native durable inbox submission promotes, but unloaded blank sessions stay local', async () => {
      const { createUserMessage } = await importUpstream('@deepseek-ai/dsh-llm');
      const mounted = new Context(); const fiber = mounted.plugin(plugin); await fiber.await();
      try {
        const untouched = await mounted.sessionPersistence.create(header('native-blank'));
        await untouched.append([title(0)]);
        const writer = await mounted.sessionPersistence.create(header('native-inbox'));
        const message = createUserMessage({ content: [{ type: 'text', text: 'Synthetic submission; no model request.' }], source: { kind: 'user' } });
        const queued = { type: 'agent/inbox/spliced', seq: 0, time: Date.now(), data: { target: 'next-turn', start: 0, inserted: [message] } };
        mounted.emit('session/event', { id: writer.id }, queued);
        await mounted.sessionPersistence.flush();
        assert.deepEqual(sessions.get(writer.id).events, [queued]);
        await fiber.dispose(); assert.equal(sessions.has('native-blank'), false);
        const stored = JSON.parse(await readFile(join(home, 'company-pending-events/native-blank.json')));
        assert.equal(stored.local, true); assert.equal(stored.events.length, 1);
      } finally { await fiber.dispose(); await mounted.fiber.dispose(); }
    });
  } finally {
    unavailable = false; await Promise.allSettled([...service.handles].map(handle => handle.close()));
    await ctx.fiber.dispose(); company.closeAllConnections(); await new Promise(resolve => company.close(resolve));
  }
});
