import test from 'node:test';
import assert from 'node:assert/strict';
import { attachSessionHistory, followCachedHistory, installHistoryIntegration } from '../src/runtime/company-history.mjs';
import { patchHistorySource, patchHistoryRuntime } from '../../../scripts/history-runtime.mjs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const event = seq => ({ type: 'turn/start', seq, time: 100 + seq, data: { turn: seq + 1 } });
function source() {
  const items = []; let wake;
  return {
    push(value) { items.push(value); wake?.(); wake = undefined; },
    async *follow(_request, signal) {
      const abort = () => { wake?.(); wake = undefined; };
      signal.addEventListener('abort', abort);
      try { while (!signal.aborted) {
        if (!items.length) await new Promise(resolve => { wake = resolve; });
        if (items.length) yield items.shift();
      } } finally { signal.removeEventListener('abort', abort); }
    },
  };
}
const request = { address: { kind: 'session', sessionId: 'one' } };
const pause = () => new Promise(resolve => setImmediate(resolve));

test('cold follow delivers exact incremental history across snapshot races and later native activation', async () => {
  const native = source(), signal = new AbortController();
  const listeners = new Set(), stored = [event(0), event(1)];
  const backend = { readCached: async (_id, offset, length = Infinity) => ({ events: stored.slice(offset, offset + length) }) };
  const stream = followCachedHistory(native.follow, native, request, signal.signal, backend, listener => { listeners.add(listener); return () => listeners.delete(listener); });
  const first = stream.next(); await pause();
  for (const notify of listeners) notify({ id: 'one' }); // Remote tail lands before opening snapshot.
  native.push({ type: 'snapshot', cursor: 0, records: [{ type: 'event', event: stored[0] }], hasMore: false });
  assert.equal((await first).value.cursor, 0);
  assert.deepEqual((await stream.next()).value, { type: 'event', event: stored[1] });
  const next = stream.next();
  native.push({ type: 'event', event: stored[1] }); // Native created/seed repeats already shown remote tail.
  stored.push(event(2), event(3));
  native.push({ type: 'event', event: stored[3] }); // Missing UI notification is repaired from exact local cache.
  assert.deepEqual((await next).value.event, stored[2]);
  assert.deepEqual((await stream.next()).value.event, stored[3]);
  signal.abort(); await stream.return(); assert.equal(listeners.size, 0);
});

test('history integration releases promotion, gates actual submissions and publishes cold projections without live append', async () => {
  const calls = [], rows = [], controls = []; let notify, denied = false, released = 0;
  const snapshot = { header: { id: 'one', cwd: 'C:/test', createdAt: 5 },
    projections: { asOfSeq: 4, values: { sessionListMetadata: { blank: false, lastPromptAt: 10 }, title: { title: 'Updated' } } },
    [Symbol.dispose]() { released++; },
  };
  let live;
  const ctx = { sessions: { get: () => live }, sessionQuery: { observeSession: async () => snapshot }, emit: (name, row) => rows.push({ name, row }) };
  const controller = { promote() { throw new Error('must not activate'); }, history: source(),
    commands: { async prompt(...args) { calls.push('prompt'); return args; } },
    listState: { list: async () => [], summaryFor: () => ({}), summarizeCold: () => ({ sessionId: 'one', blank: true }) }, controlState: { broadcast: value => controls.push(value) } };
  const oldPromote = controller.promote;
  const backend = { ensureWrite: async (_id, options) => { calls.push(options.submission); if (denied) throw new Error('lease denied'); },
    onRemoteChange: listener => { notify = listener; return () => { notify = null; }; },
    readCached: async () => ({ events: [event(5)] }) };
  const dispose = attachSessionHistory(ctx, controller, backend);
  controller.promote(snapshot); assert.equal(released, 1);
  await controller.commands.prompt({ sessionId: 'one', content: ['test'] }, 'source');
  assert.deepEqual(calls, [true, 'prompt']);
  denied = true;
  await assert.rejects(controller.commands.prompt({ sessionId: 'one' }), /lease denied/);
  assert.equal(calls.filter(value => value === 'prompt').length, 1);
  await notify({ id: 'one', events: [event(4)] });
  assert.equal(rows[0].row.blank, false); assert.equal(rows[0].row.updatedAt, 10);
  assert.equal(rows[0].row.projections.asOfSeq, 4); assert.equal(controls.length, 2);
  live = { seq: 5 };
  await assert.rejects(notify({ id: 'one' }), /其他设备更新/);
  dispose(); assert.equal(controller.promote, oldPromote); assert.equal(notify, null);
});

test('the final native tools/execute gate rechecks ownership after a human approval wait', async () => {
  const hooks = new Map(); let allowed = true, dispatched = 0;
  const ctx = { inject() {}, on(name, fn) { hooks.set(name, fn); } };
  const backend = { ensureWrite: async () => { if (!allowed) throw new Error('authorization expired'); } };
  installHistoryIntegration(ctx, backend);
  const execution = { agent: { id: 'one' }, signal: new AbortController().signal };
  assert.deepEqual(await hooks.get('tools/pre-execute')(execution, async () => ({ kind: 'ask' })), { kind: 'ask' });
  allowed = false; // Approval can remain open past a lease expiry or revocation.
  await assert.rejects(hooks.get('tools/execute')(execution, async () => { dispatched++; }), /authorization expired/);
  assert.equal(dispatched, 0);
});

test('a slow cold observation cannot overwrite a newly resumed Agent or publish after unload', async () => {
  let notify, resolveObservation, live;
  const rows = [], controls = [];
  const ctx = { sessions: { get: () => live }, sessionQuery: { observeSession: () => new Promise(resolve => { resolveObservation = resolve; }) }, emit: (...args) => rows.push(args) };
  const controller = { promote() {}, history: source(), commands: { prompt() {} }, listState: { list: async () => [], summaryFor: () => ({}), summarizeCold: () => ({ running: false }) }, controlState: { broadcast: row => controls.push(row) } };
  const backend = { onRemoteChange: listener => { notify = listener; return () => {}; } };
  const dispose = attachSessionHistory(ctx, controller, backend);
  let released = 0;
  const observation = { header: { id: 'one', cwd: 'C:/test' }, projections: { asOfSeq: 1, values: { title: {} } }, [Symbol.dispose]() { released++; } };
  const updating = notify({ id: 'one' }); live = { seq: 2 }; resolveObservation(observation); await updating;
  assert.equal(rows.length, 0); assert.equal(controls.length, 0);
  live = undefined;
  const unloading = notify({ id: 'one' }); dispose(); resolveObservation(observation); await unloading;
  assert.equal(rows.length, 0); assert.equal(released, 2);
});

test('initial cold list restores native title/blank/last prompt projections without opening an Agent or acquiring ownership', async () => {
  const observed = [], released = [], emissions = [], rows = [
    { sessionId: 'older-created', updatedAt: 1, blank: false }, { sessionId: 'newer-created', updatedAt: 2, blank: false },
    { sessionId: 'blank', updatedAt: 3, blank: false }, { sessionId: 'legacy', updatedAt: 0, formatStatus: 'migration-required' },
  ];
  const values = {
    'older-created': { sessionListMetadata: { blank: false, lastPromptAt: 50 }, title: { title: '最近提问' } },
    'newer-created': { sessionListMetadata: { blank: false, lastPromptAt: 20 }, title: { title: '较早提问' } },
    blank: { sessionListMetadata: { blank: true, lastPromptAt: null } },
  };
  const ctx = { sessions: { get: () => undefined }, emit: (...args) => emissions.push(args), sessionQuery: { async observeSession(id, options) {
    observed.push({ id, options }); return { header: { id, createdAt: 3 }, projections: { asOfSeq: 9, values: values[id] }, [Symbol.dispose]() { released.push(id); } };
  } } };
  const nativeList = async () => rows;
  const controller = { promote() { throw new Error('must not resume'); }, history: source(), commands: { prompt() {} },
    listState: { list: nativeList, summaryFor() { throw new Error('not live'); }, summarizeCold() {} }, controlState: { broadcast() { throw new Error('read-only list'); } } };
  const backend = { stat: async id => ({ revision: id }), ensureWrite() { throw new Error('must not acquire ownership'); }, onRemoteChange: () => () => {} };
  const dispose = attachSessionHistory(ctx, controller, backend), signal = new AbortController().signal;
  const listed = await controller.listState.list(signal);
  assert.deepEqual(listed.map(row => row.sessionId), ['older-created', 'newer-created', 'blank', 'legacy']);
  assert.deepEqual(listed.map(row => row.updatedAt), [50, 20, 3, 0]);
  assert.equal(listed[0].projections.values.title.title, '最近提问'); assert.equal(listed[2].blank, true);
  assert.deepEqual(observed.map(row => row.id), ['older-created', 'newer-created', 'blank']);
  assert.ok(observed.every(row => row.options.projectionMode === 'all' && row.options.signal === signal));
  assert.deepEqual(released, ['older-created', 'newer-created', 'blank']); assert.equal(emissions.length, 0);
  assert.equal(rows[0].updatedAt, 1); dispose(); assert.equal(controller.listState.list, nativeList);
});

test('cold list observation releases on cancellation/unload and never replaces a concurrently resumed live summary', async () => {
  for (const scenario of ['resume', 'abort', 'unload']) {
    let resolveObservation, live, released = 0;
    const ctx = { sessions: { get: () => live }, emit() {}, sessionQuery: { observeSession: () => new Promise(resolve => { resolveObservation = resolve; }) } };
    const liveRow = { sessionId: 'one', updatedAt: 999, running: true, agentAvailable: true };
    const controller = { promote() {}, history: source(), commands: { prompt() {} },
      listState: { list: async () => [{ sessionId: 'one', updatedAt: 1 }], summaryFor: value => { assert.equal(value, live); return liveRow; }, summarizeCold() {} },
      controlState: { broadcast() {} } };
    const dispose = attachSessionHistory(ctx, controller, { stat: async () => ({ revision: 'one:3' }), onRemoteChange: () => () => {} });
    const abort = new AbortController(), pending = controller.listState.list(abort.signal); await pause();
    const rejected = scenario === 'resume' ? undefined : assert.rejects(pending);
    if (scenario === 'resume') live = { id: 'one' }; else if (scenario === 'abort') abort.abort(); else dispose();
    resolveObservation({ header: { id: 'one', createdAt: 1 }, projections: { asOfSeq: 2, values: { sessionListMetadata: { blank: false, lastPromptAt: 8 } } }, [Symbol.dispose]() { released++; } });
    if (scenario === 'resume') assert.deepEqual(await pending, [liveRow]); else await rejected;
    assert.equal(released, 1); dispose();
  }
});

test('cold list memo reuses native wire projections beyond the prepared cache and isolates damaged records', async () => {
  const rows = Array.from({ length: 6 }, (_, index) => ({ sessionId: String(index), updatedAt: index }));
  rows.push({ sessionId: 'damaged', updatedAt: 0 }, { sessionId: 'native-cached', updatedAt: 99,
    projections: { asOfSeq: 9, values: { sessionListMetadata: { blank: false, lastPromptAt: 99 }, title: 'Native title' } } });
  const revisions = new Map(rows.map(row => [row.sessionId, 10])), observed = [], released = [], warnings = [];
  let notify;
  const ctx = { sessions: { get: () => undefined }, emit() {}, logger: { warn: message => warnings.push(message) },
    sessionQuery: { async observeSession(id) {
      observed.push(id);
      if (id === 'damaged') throw new Error('sensitive original failure must not be logged');
      const revision = revisions.get(id);
      return { header: { id, cwd: 'C:/test', createdAt: 0 }, revision: `${id}:${revision}`,
        projections: { asOfSeq: revision - 1, values: { sessionListMetadata: { blank: false, lastPromptAt: revision + Number(id) }, title: `Title ${id}:${revision}` } },
        get events() { throw new Error('must not retain/read full events'); }, [Symbol.dispose]() { released.push(id); } };
    } } };
  const controller = { promote() {}, history: source(), commands: { prompt() {} },
    listState: { list: async () => rows, summaryFor() {}, summarizeCold: ({ header }) => ({ sessionId: header.id }) }, controlState: { broadcast() {} } };
  const backend = { stat: async id => ({ revision: `${id}:${revisions.get(id)}`, eventCount: revisions.get(id) }),
    onRemoteChange: callback => { notify = callback; return () => {}; } };
  const dispose = attachSessionHistory(ctx, controller, backend);
  const first = await controller.listState.list(), second = await controller.listState.list();
  assert.deepEqual(second, first);
  assert.equal(observed.length, 8); // Six real observations once; failed row retried on each list.
  assert.equal(released.length, 6); assert.equal(warnings.length, 2);
  assert.ok(warnings.every(message => !message.includes('sensitive')));
  assert.ok(second.some(row => row.sessionId === 'damaged'));
  assert.ok(!observed.includes('native-cached'));
  revisions.set('0', 200);
  const changed = await controller.listState.list();
  assert.equal(changed[0].sessionId, '0'); assert.equal(changed[0].updatedAt, 200);
  assert.equal(changed[0].projections.values.title, 'Title 0:200');
  assert.equal(observed.filter(id => id === '0').length, 2);
  assert.equal(observed.filter(id => id === '1').length, 1);
  revisions.set('1', 300); await notify({ id: '1' });
  const before = observed.length, remote = await controller.listState.list();
  assert.equal(remote[0].sessionId, '1'); assert.equal(observed.length, before + 1); // Only failed row retries.
  dispose();
});

test('exact cold-history extension is pinned, idempotent and rejects a changed upstream implementation', async () => {
  const original = 'async function readColdSessionLog(persistence, sessionId, signal) { return {events: [...events, ...interruptedTurnClosers(events)]}; }';
  const patched = patchHistorySource(original);
  assert(patched.includes('persistence.rufaExactHistory === true'));
  assert.equal(patchHistorySource(patched), patched);
  assert.throws(() => patchHistorySource('unknown source'), /implementation changed/);
});

test('real pinned cold reader preserves a remotely active turn instead of inventing closing sequence numbers', { skip: !process.env.RUFA_RUNTIME_ROOT }, async () => {
  await patchHistoryRuntime(process.env.RUFA_RUNTIME_ROOT);
  const { readColdSessionLog } = await import(pathToFileURL(join(process.env.RUFA_RUNTIME_ROOT, 'node_modules/@deepseek-ai/dsh-session-query/lib/index.js')));
  const events = [event(0)]; let closes = 0;
  const persistence = { rufaExactHistory: true, open: async () => ({ header: { id: 'one' }, inheritedEventCount: 0,
    read: async () => ({ events, eventState: 'shared-frozen' }), close: async () => { closes++; } }) };
  assert.deepEqual((await readColdSessionLog(persistence, 'one')).events, events);
  persistence.rufaExactHistory = false;
  assert((await readColdSessionLog(persistence, 'one')).events.length > events.length);
  assert.equal(closes, 2);
});
