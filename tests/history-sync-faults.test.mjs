// Real company HTTP, client bridge and SQLite on both sides; only the transport is faulted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../apps/server/dist/app.js';
import { configFromEnv } from '../apps/server/dist/config.js';
import { SqliteStore } from '../apps/server/dist/sqlite-store.js';
import { hashPassword } from '../apps/server/dist/security.js';
import { CompanyApi } from '../apps/client/dist/company-api.js';
import { RuntimeBridge } from '../apps/client/dist/runtime-bridge.js';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const deadline = async promise => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Fault fixture timeout')), 20000); })]); }
  finally { clearTimeout(timer); }
};
const event = seq => ({ seq, type: seq === 0 ? 'turn/start' : 'tool/call', time: 100 + seq,
  data: seq === 0 ? { turn: 1 } : { turn: 1, step: seq, callId: `fixture-${seq}`, name: 'synthetic', arguments: JSON.stringify({ seq, text: '完整事件，不执行工具', nested: [seq, true] }) } });

test('abrupt process exits retain exact events and resume through the real authorized service', { skip: !process.env.RUFA_RUNTIME_ROOT, timeout: 120000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rufa-history-faults-'));
  const store = SqliteStore.open(join(directory, 'server.sqlite'));
  const password = 'Synthetic-only-fault-test-2026';
  await store.createUser({ username: 'fault-user', displayName: 'Synthetic', role: 'admin', passwordHash: await hashPassword(password) }, true);
  let clockOffset = 0;
  const app = buildApp(store, { ...configFromEnv({}), now: () => Date.now() + clockOffset }, () => store.ping());
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  let fault, gatewayRequests = 0;
  const request = async (...args) => {
    const path = String(args[0]);
    if (path.includes('/gateway/')) { gatewayRequests++; throw new Error('No model calls allowed'); }
    const current = fault;
    if (current && args[1]?.method === 'POST' && path.endsWith(`/sessions/${current.sessionId}/events`)) {
      current.seen++;
      if (current.seen === current.batch) {
        if (current.phase === 'after-commit') {
          const response = await fetch(...args);
          assert.equal(response.status, 200);
          // Consume a real successful server response before simulating its loss.
          await response.json();
        }
        current.entered.resolve();
        await current.release.promise;
        throw new Error('Synthetic connection lost at the crash boundary');
      }
    }
    return fetch(...args);
  };
  const api = new CompanyApi({ read: async () => null, write: async () => {}, clear: async () => {} }, true, request);
  await api.login(url, 'fault-user', password);
  const bridge = new RuntimeBridge(api); await bridge.start();
  const children = new Set(), reports = [];
  async function worker(home) {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/history-fault-worker.mjs', import.meta.url))], {
      windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { ...process.env, DSH_HOME: home, RUFA_BRIDGE_ORIGIN: bridge.origin, RUFA_BRIDGE_TOKEN: bridge.token, RUFA_DEVICE_ID: api.state.deviceId },
    });
    children.add(child);
    let serial = 0, diagnostics = ''; const waiting = new Map(), ready = deferred();
    child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-4000); });
    child.on('message', message => {
      if (message.ready) ready.resolve();
      const waiter = waiting.get(message.id);
      if (waiter) { waiting.delete(message.id); message.error ? waiter.reject(new Error(message.error)) : waiter.resolve(message.value); }
    });
    child.on('exit', code => { children.delete(child); for (const waiter of waiting.values()) waiter.reject(new Error(`Owned worker exited ${code}: ${diagnostics}`)); waiting.clear(); });
    child.on('error', error => { ready.resolve(); for (const waiter of waiting.values()) waiter.reject(error); });
    await deadline(ready.promise);
    return { child,
      call(action, values = {}) { return deadline(new Promise((resolve, reject) => { const id = ++serial; waiting.set(id, { resolve, reject }); child.send({ action, id, ...values }); })); },
      async kill() { if (child.exitCode !== null || child.signalCode !== null) return; const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; },
    };
  }
  async function cloudEvents(id) {
    const events = []; let after = -1;
    while (true) {
      const page = await api.json('GET', `/sessions/${id}/events?afterSeq=${after}&limit=500`);
      events.push(...page.events.map(row => row.event));
      if (!page.events.length || events.length >= page.nextSeq) return events;
      after = events.length - 1;
    }
  }
  try {
    for (const scenario of [
      { name: 'before-upload', count: 7, phase: 'before-upload', batch: 1, committed: 0 },
      { name: 'after-commit-before-ack', count: 7, phase: 'after-commit', batch: 1, committed: 7 },
      { name: 'between-pages', count: 607, phase: 'before-upload', batch: 2, committed: 500 },
      { name: 'second-page-ack-lost', count: 607, phase: 'after-commit', batch: 2, committed: 607 },
      { name: 'live-callback-immediate-exit', count: 3, live: true, committed: 0 },
      { name: 'live-remote-immediate-exit', count: 3, live: true, remoteLive: true, committed: 1 },
    ]) await t.test(scenario.name, async () => {
      const sessionId = `fault-${scenario.name}`, home = join(directory, scenario.name);
      const header = { id: sessionId, version: 4, createdAt: 100, cwd: home, isSeeded: false };
      const events = Array.from({ length: scenario.count }, (_, seq) => event(seq));
      const first = await worker(home);
      let pending;
      try {
        if (scenario.live) {
          if (scenario.remoteLive) await first.call('write', { header, events: events.slice(0, 1) });
          const exited = once(first.child, 'exit');
          pending = first.call(scenario.remoteLive ? 'enqueue-existing-crash' : 'enqueue-crash', { header, events: scenario.remoteLive ? events.slice(1) : events }).catch(error => error);
          const [code, signal] = await deadline(exited);
          assert.ok(signal === 'SIGKILL' || (Number.isInteger(code) && code !== 0), 'worker was terminated without graceful shutdown');
        } else {
          fault = { ...scenario, sessionId, seen: 0, entered: deferred(), release: deferred() };
          pending = first.call('write', { header, events }).catch(error => error);
          await deadline(fault.entered.promise);
          assert.equal((await cloudEvents(sessionId)).length, scenario.committed);
          await first.kill(); fault.release.resolve(); fault = undefined;
        }
        await pending;
      } finally { if (fault) { fault.release.resolve(); fault = undefined; } await first.kill(); }
      const second = await worker(home);
      try {
        const cached = await second.call('cached', { sessionId });
        assert.deepEqual(cached.events, events, 'all accepted events survived without graceful shutdown');
        const tail = event(events.length);
        const recovered = await second.call('resume', { sessionId, events: [tail] });
        assert.deepEqual(recovered.events, [...events, tail]);
        assert.equal(recovered.syncedSeq, events.length + 1);
        assert.deepEqual(await cloudEvents(sessionId), [...events, tail], 'exact original events, no duplicates or omitted rows');
        await second.call('close');
        reports.push({ scenario: scenario.name, retainedEvents: events.length, cloudBeforeRestart: scenario.committed, resumedEvents: recovered.events.length });
      } finally { await second.kill(); }
    });
    await t.test('expired lease is reacquired only on explicit verified user recovery', async () => {
      const sessionId = 'fault-explicit-expiry-resume', home = join(directory, sessionId);
      const client = await worker(home), events = [event(0), event(1)];
      try {
        await client.call('write', { header: { id: sessionId, version: 4, createdAt: 100, cwd: home, isSeeded: false }, events });
        clockOffset = 125000; // Real server clock crosses its 120-second lease, login remains valid.
        const result = await client.call('explicit-expiry-resume', { sessionId, events: [event(2)] });
        assert.notEqual(result.oldLease, result.newLease, 'server issued a new fencing token after actual lease expiry');
        assert.ok(result.observations >= 2, 'native snapshot is rechecked before and after remote I/O');
        assert.deepEqual(result.record.events, [event(0), event(1), event(2)]);
        assert.deepEqual(await cloudEvents(sessionId), result.record.events);
        reports.push({ scenario: 'explicit-expiry-resume', renewedLease: true, events: 3 });
        await client.call('close');
      } finally { clockOffset = 0; await client.kill(); }
    });
    assert.equal(gatewayRequests, 0);
  } finally {
    fault?.release.resolve(); fault = undefined;
    await Promise.all([...children].map(async child => { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }));
    await bridge.stop(); await app.close(); await store.close();
    await writeFile(join(directory, 'report.json'), JSON.stringify({ gatewayRequests, scenarios: reports }, null, 2));
    t.diagnostic(`Real HTTP/SQLite with owned child-process termination: ${directory}`);
  }
});
