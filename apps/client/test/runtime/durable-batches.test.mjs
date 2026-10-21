import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('events accepted while journaling never reach the cloud ahead of their exact SQLite prefix', { skip: !process.env.RUFA_RUNTIME_ROOT }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'rufa-durable-batches-'));
  const header = { id: 'synthetic-resumed', version: 4, isSeeded: false, createdAt: 1, cwd: 'C:/synthetic-office' };
  const event = seq => ({ type: 'tool/call', seq, time: seq + 2, data: { turn: 1, step: 1, callId: `tool-${seq}`, name: 'synthetic', arguments: JSON.stringify({ seq, content: '保留完整原事件' }) } });
  let events = [event(0)], injectDuringPost, service, writer;
  const requests = [], cloudAheadOfCache = [];
  const summary = () => ({ id: header.id, upstreamHeader: header, nextSeq: events.length, inheritedEventCount: 0, updatedAt: 'synthetic' });
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {}, url = new URL(req.url, 'http://127.0.0.1');
    res.setHeader('content-type', 'application/json');
    if (url.pathname.endsWith('/lease')) {
      if (req.method === 'DELETE') { res.statusCode = 204; return res.end(); }
      return res.end(JSON.stringify({ leaseId: 'synthetic-lease', nextSeq: events.length, expiresAt: new Date(Date.now() + 120000).toISOString() }));
    }
    if (url.pathname.endsWith('/events')) {
      if (req.method === 'GET') {
        const start = Number(url.searchParams.get('afterSeq')) + 1;
        return res.end(JSON.stringify({ events: events.slice(start, start + Number(url.searchParams.get('limit'))).map(event => ({ seq: event.seq, event })), nextSeq: events.length }));
      }
      requests.push(body);
      if (body.expectedNextSeq !== events.length || body.events.some((row, i) => row.seq !== events.length + i)) { res.statusCode = 409; return res.end('{}'); }
      for (const row of body.events) {
        if (!service.cache.read(header.id, row.seq, 1).length) cloudAheadOfCache.push(row.seq);
        events.push(row.event);
      }
      injectDuringPost?.();
      return res.end(JSON.stringify({ nextSeq: events.length }));
    }
    res.end(JSON.stringify({ session: summary() }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  Object.assign(process.env, { DSH_HOME: home, RUFA_BRIDGE_ORIGIN: `http://127.0.0.1:${server.address().port}`, RUFA_BRIDGE_TOKEN: 'synthetic', RUFA_DEVICE_ID: 'synthetic' });
  const { importUpstream } = await import('../../src/runtime/import-upstream.mjs');
  const { Context } = await importUpstream('@deepseek-ai/cordis');
  const { RemotePersistence } = await import('../../src/runtime/remote-persistence.mjs');
  let ctx = new Context(); service = new RemotePersistence(ctx);
  try {
    writer = await service.open(header.id, 'write');
    const staleReader = await service.open(header.id, 'read');
    assert.equal(staleReader.nextSeq, 1);
    let injected = false, postInjected = false;
    const journal = writer.journalPending.bind(writer);
    writer.journalPending = async () => {
      const durable = await journal();
      if (!injected && durable.events.some(row => row.seq === 1)) { injected = true; writer.enqueueLive(event(2)); }
      return durable;
    };
    injectDuringPost = () => { if (!postInjected) { postInjected = true; writer.enqueueLive(event(3)); } };
    await writer.append([event(1)]);
    await writer.flush();
    assert.deepEqual(cloudAheadOfCache, []);
    assert.deepEqual(events, [0, 1, 2, 3].map(event));
    assert.deepEqual(service.cache.read(header.id), events);
    const cached = service.cache.get(header.id);
    assert.equal(cached.eventCount, 4); assert.equal(cached.syncedSeq, 4);
    assert.deepEqual((await staleReader.read()).events, events);
    assert.deepEqual((await staleReader.read(2)).events, events.slice(2));
    assert.equal(staleReader.nextSeq, 1, 'Read handles may retain their original observation cursor');
    assert.equal(service.cache.get(header.id).syncedSeq, 4, 'A stale read handle never rewinds the durable sync checkpoint');
    await staleReader.close();
    assert.deepEqual(JSON.parse(await readFile(writer.journal, 'utf8')).events, []);
    assert.ok(requests.length >= 2, 'Events accepted during a POST remain a later durable batch');
    await writer.close(); writer = null;
    const reopened = await service.open(header.id, 'write');
    assert.deepEqual((await reopened.read()).events, events); await reopened.close();
    // Affected 0.2.2 shape: cloud committed a suffix that survived in the journal
    // but not SQLite. Opening must verify cloud bytes and append, never clear or
    // renumber the existing database prefix or discard the recovery journal.
    events.push(...Array.from({ length: 114 }, (_, i) => event(i + 4)));
    await service.sync(header.id);
    const prefix = service.cache.read(header.id), prefixCount = prefix.length;
    assert.equal(prefixCount, 118);
    writer = await service.open(header.id, 'write');
    const recovery = [118, 119, 120].map(event);
    const saved = JSON.stringify({ id: header.id, header, inheritedEventCount: 0, local: false, nextSeq: prefixCount, events: recovery });
    await writeFile(service.journalPath(header.id), saved);
    events.push(...recovery);
    // Model the previously stuck process after its successful cloud response.
    // The invariant remains strict; a fresh runtime repairs from verified facts.
    writer.nextSeq = 121;
    assert.throws(() => writer.retainCache(), /Invalid local synchronization checkpoint/);
    assert.deepEqual(service.cache.read(header.id), prefix);
    clearInterval(writer.heartbeat); clearTimeout(writer.timer); writer.closed = true;
    service.handles.delete(writer); service.writers.delete(writer.id); writer = null;
    await service.stopBackground(); service.cache.close(); await ctx.fiber.dispose();
    ctx = new Context(); service = new RemotePersistence(ctx);
    writer = await service.open(header.id, 'write');
    assert.deepEqual(service.cache.read(header.id, 0, prefixCount), prefix);
    assert.deepEqual((await writer.read()).events, events);
    assert.equal(service.cache.get(header.id).syncedSeq, 121);
    assert.equal(await readFile(writer.journal, 'utf8'), saved, 'Recovery evidence remains until a successful durable flush');
    await writer.flush(); await writer.close(); writer = null;
    t.diagnostic(`Isolated SQLite evidence: ${home}`);
  } finally {
    if (writer) { clearInterval(writer.heartbeat); clearTimeout(writer.timer); writer.closed = true; service.handles.delete(writer); service.writers.delete(writer.id); }
    await service.stopBackground(); service.cache.close(); await ctx.fiber.dispose();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
