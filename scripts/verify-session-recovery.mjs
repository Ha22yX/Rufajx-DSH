// Replay an authorized backup through real persistence against a loopback fixture.
// No Agent, model request, business tool or real company API is started.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const [backup, runtime, plugins, id] = process.argv.slice(2);
assert.ok(backup && runtime && plugins && id, 'Usage: BACKUP RUNTIME PLUGINS SESSION_ID');
const proof = JSON.parse(await readFile(join(backup, 'cloud-fingerprints.json'), 'utf8')).find(row => row.session.id === id);
assert.ok(proof, 'An independently verified cloud fingerprint is required');
const home = await mkdtemp(join(tmpdir(), 'rufa-recovery-replay-'));
await cp(join(backup, 'installed/company-history.sqlite'), join(home, 'company-history.sqlite'));
await cp(join(backup, 'installed/company-pending-events'), join(home, 'company-pending-events'), { recursive: true });
const db = new DatabaseSync(join(home, 'company-history.sqlite'), { readOnly: true });
const record = db.prepare('SELECT * FROM sessions WHERE id=?').get(id);
const prefix = db.prepare('SELECT event FROM events WHERE session_id=? ORDER BY seq').all(id).map(row => JSON.parse(row.event));
db.close();
const journal = JSON.parse(await readFile(join(home, 'company-pending-events', `${id}.json`), 'utf8'));
const events = [...prefix];
for (const event of journal.events) {
  if (event.seq < events.length) assert.deepEqual(event, events[event.seq]);
  else { assert.equal(event.seq, events.length); events.push(event); }
}
assert.equal(events.length, proof.session.next_seq);
for (const [seq, event] of events.entries()) {
  assert.equal(event.seq, seq);
  assert.equal(createHash('sha256').update(JSON.stringify(event)).digest('hex'), proof.events[seq].sha256);
}
const requests = [];
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  requests.push(`${req.method} ${url.pathname}`);
  const base = `/company/sessions/${encodeURIComponent(id)}`;
  res.setHeader('content-type', 'application/json');
  if (url.pathname === base && req.method === 'GET') return res.end(JSON.stringify({ session: {
    id, upstreamHeader: JSON.parse(record.header), inheritedEventCount: record.inherited,
    nextSeq: events.length, updatedAt: 'verified-backup',
  } }));
  if (url.pathname === base + '/events' && req.method === 'GET') {
    const from = Number(url.searchParams.get('afterSeq')) + 1;
    return res.end(JSON.stringify({ events: events.slice(from, from + Number(url.searchParams.get('limit'))).map(event => ({ seq: event.seq, event })), nextSeq: events.length }));
  }
  if (url.pathname === base + '/lease') {
    if (req.method === 'DELETE') { res.statusCode = 204; return res.end(); }
    if (req.method === 'POST') return res.end(JSON.stringify({ leaseId: 'isolated-replay', nextSeq: events.length, expiresAt: new Date(Date.now() + 120000).toISOString() }));
  }
  res.statusCode = 403; res.end(JSON.stringify({ error: { code: 'FIXTURE_REFUSED' } }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
Object.assign(process.env, { DSH_HOME: home, RUFA_RUNTIME_ROOT: resolve(runtime),
  RUFA_BRIDGE_ORIGIN: `http://127.0.0.1:${server.address().port}`, RUFA_BRIDGE_TOKEN: 'isolated-backup-replay', RUFA_DEVICE_ID: 'isolated-replay' });
const { importUpstream } = await import(pathToFileURL(join(plugins, 'import-upstream.mjs')).href);
const { Context } = await importUpstream('@deepseek-ai/cordis');
const { RemotePersistence } = await import(pathToFileURL(join(plugins, 'remote-persistence.mjs')).href);
const ctx = new Context(), service = new RemotePersistence(ctx);
try {
  const writer = await service.open(id, 'write');
  assert.deepEqual((await writer.read()).events, events);
  assert.deepEqual(service.cache.read(id, 0, prefix.length), prefix);
  await service.ensureWrite(id, { submission: true });
  await writer.close();
  const after = service.cache.get(id);
  assert.equal(after.eventCount, events.length); assert.equal(after.syncedSeq, events.length);
  assert.equal(after.conflict, null);
  assert.ok(requests.every(row => row.startsWith('GET ') || row.endsWith('/lease')));
  const report = { passed: true, sourceEvents: prefix.length, recoveredEvents: events.length - prefix.length,
    verifiedCloudEvents: events.length, writeAdmission: true, originalPrefixUnchanged: true,
    actualCompanyRequests: 0, modelRequests: 0, toolExecutions: 0, fixtureRequests: requests.length, home };
  await writeFile(join(home, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await service.stopBackground(); service.cache.close(); await ctx.fiber.dispose();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
