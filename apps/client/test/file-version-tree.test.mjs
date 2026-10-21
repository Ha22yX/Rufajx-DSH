import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { buildFileVersionGraph, fileVersionTree } from '../src/runtime/file-version-tree.mjs';
import { createVersionService } from '../src/runtime/file-versions.mjs';
import { createFileVersionStore } from '../src/runtime/file-version-store.mjs';
import { createVersionScopes } from '../src/runtime/file-version-tracking.mjs';

const row = (id, hash, phase = 'after', extra = {}) => ({ id, hash, phase, path: '/fixture/report.txt', name: 'report.txt',
  size: hash === null ? 0 : 10, createdAt: '2026-10-19T12:00:00.000Z', operationId: `operation-${id}`, ...extra });
const graphOf = chronological => buildFileVersionGraph([...chronological].reverse());
const topology = graph => graph.nodes.map(({ id, parentId }) => [id, parentId]);

test('ordinary revisions retain insertion order and stable ids when consecutive byte-identical snapshots collapse', () => {
  const rows = [row('a', 'A', 'before'), row('b', 'B'), row('c', 'B', 'before'), row('d', 'C')];
  const graph = graphOf(rows);
  assert.deepEqual(topology(graph), [['a', null], ['b', 'a'], ['d', 'b']]);
  assert.equal(graph.rawToNode.get('c').id, 'b'); assert.equal(graph.compareByRaw.get('c'), 'a');
  assert.deepEqual(graph.nodes.map(node => node.number), [1, 2, 3]);
  assert.deepEqual(topology(graphOf([...rows, row('e', 'C')])), topology(graph));
  assert.deepEqual(JSON.parse(JSON.stringify(graph.nodes)), graph.nodes);
  assert.equal(JSON.stringify(graph.nodes).includes('operationId'), false); assert.equal(JSON.stringify(graph.nodes).includes('hash'), false);
});

test('completed restores branch from the exact source alias and preserve the original route plus the actual backup comparison', () => {
  const rows = [row('a', 'A'), row('b', 'B'), row('b-alias', 'B', 'before'), row('c', 'C'),
    row('backup', 'C', 'before-restore', { operationId: 'restore-one', operationStatus: 'completed' }),
    row('restored', 'B', 'restored', { operationId: 'restore-one', operationStatus: 'completed', restoredFromId: 'b-alias', restoredFromCurrentId: 'backup' }),
    row('next', 'D')];
  const graph = graphOf(rows), restored = graph.rawToNode.get('restored');
  assert.equal(restored.parentId, 'b'); assert.equal(restored.restoredFromId, 'b');
  assert.equal(restored.restoredFromCurrentId, 'backup'); assert.equal(restored.compareBeforeId, 'backup');
  assert.equal(graph.rawToNode.get('backup').kind, 'backup'); assert.equal(graph.rawToNode.get('next').parentId, 'restored');
  assert.deepEqual(topology(graph).slice(0, 4), [['a', null], ['b', 'a'], ['c', 'b'], ['backup', 'c']]);
});

test('repeated restores to equal bytes in separate eras never guess an earlier or later hash match as the source', () => {
  const rows = [row('a', 'A'), row('b', 'B'), row('a-later', 'A'), row('c', 'C'),
    row('backup1', 'C', 'before-restore', { operationId: 'r1' }),
    row('r1', 'A', 'restored', { operationId: 'r1', operationStatus: 'completed', restoredFromId: 'a', restoredFromCurrentId: 'backup1' }),
    row('d', 'D'), row('backup2', 'D', 'before-restore', { operationId: 'r2' }),
    row('r2', 'A', 'restored', { operationId: 'r2', operationStatus: 'completed', restoredFromId: 'a-later', restoredFromCurrentId: 'backup2' })];
  const graph = graphOf(rows);
  assert.equal(graph.rawToNode.get('r1').parentId, 'a'); assert.equal(graph.rawToNode.get('r2').parentId, 'a-later');
  assert.notEqual(graph.rawToNode.get('r1').id, graph.rawToNode.get('r2').id);
  for (const node of graph.nodes) if (node.parentId) assert.ok(graph.nodes.findIndex(prior => prior.id === node.parentId) < graph.nodes.indexOf(node));
});

test('unknown, failed, missing-source or mismatched restoration metadata cannot create a successful branch', () => {
  const prefix = [row('a', 'A'), row('backup', 'B', 'before-restore', { operationId: 'r' })];
  for (const extra of [
    { operationStatus: 'unknown' }, { operationStatus: 'failed' }, { restoredFromId: 'missing' },
    { restoredFromCurrentId: 'a' }, { hash: 'different' },
  ]) {
    const last = row('restored', 'A', 'restored', { operationId: 'r', operationStatus: 'completed', restoredFromId: 'a', restoredFromCurrentId: 'backup', ...extra });
    const graph = graphOf([...prefix, last]), node = graph.rawToNode.get('restored');
    assert.equal(node.kind, 'uncertain'); assert.equal(node.parentId, null); assert.equal(node.restoredFromId, undefined);
    assert.equal(fileVersionTree([last, ...prefix.toReversed()], graph, { hash: last.hash }).currentState, 'unavailable');
  }
});

test('current-node markers require a live match to the latest snapshot and never use an older identical hash', () => {
  const rows = [row('c', 'C'), row('b', 'B'), row('a', 'A')], graph = buildFileVersionGraph(rows);
  assert.equal(fileVersionTree(rows, graph, { hash: 'C' }).currentId, 'c');
  const changed = fileVersionTree(rows, graph, { hash: 'A' });
  assert.equal(changed.currentState, 'changed'); assert.equal(changed.currentId, null);
  assert.equal(fileVersionTree(rows, graph, { hash: null }).currentState, 'missing');
  assert.equal(fileVersionTree(rows, graph, undefined).currentState, 'unavailable');
  const unknown = [row('backup', 'C', 'before-restore', { operationStatus: 'unknown' }), ...rows];
  assert.equal(fileVersionTree(unknown, buildFileVersionGraph(unknown), { hash: 'C' }).currentId, null);
});

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rufa-version-tree-'))), privateRoot = join(root, 'company');
  const accountHome = join(privateRoot, 'accounts', 'tree-test'), cwd = join(accountHome, 'workspaces', 'project'), runtimeRoot = join(root, 'runtime');
  await mkdir(cwd, { recursive: true }); await mkdir(runtimeRoot);
  const file = join(cwd, 'report.txt'), sessionId = 'tree-session', coordinates = { sessionId, seq: 4, index: 0, kind: 'present' };
  let scopes = await createVersionScopes({ accountHome, privateRoot, runtimeRoot }); await scopes.grant(sessionId, cwd, 'directory');
  const ctx = { get: () => undefined, agents: { list: () => [] }, sessionQuery: { readEvent: async () => ({ session: { cwd },
    target: { type: 'deliverables/presented', data: { files: [{ path: file }] } } }) } };
  let store, service, currentReads = 0;
  const open = async () => {
    scopes = await createVersionScopes({ accountHome, privateRoot, runtimeRoot });
    store = await createFileVersionStore({ directory: join(accountHome, 'file-versions'), allowedRoots: id => scopes.roots(id), privateRoots: [runtimeRoot] });
    const current = store.current.bind(store); store.current = (...args) => { currentReads++; return current(...args); };
    service = await createVersionService({ store, scopes, ctx, pythonPath: join(process.env.RUFA_RUNTIME_ROOT, 'company-python/python.exe'), authorize: async () => {} });
  };
  await open();
  t.after(async () => {
    await service.close(); assert.equal(dirname(root), await realpath(tmpdir())); assert.ok(basename(root).startsWith('rufa-version-tree-')); await rm(root, { recursive: true, force: true });
  });
  return { file, coordinates, get store() { return store; }, get service() { return service; },
    get currentReads() { return currentReads; },
    async capture(content, phase = 'after') { if (content !== null) await writeFile(file, content); return store.capture(file, { sessionId, operationId: randomUUID(), phase }); },
    history: () => service.request('history', coordinates),
    async restore(id) { const ticket = await service.request('prepareRestore', { ...coordinates, versionId: id }); return service.request('restore', ticket); },
    async restart() { await service.close(); await open(); },
  };
}

test('actual stored restorations keep source branches, backup comparisons, alias resolution and current markers across restart', { skip: !process.env.RUFA_RUNTIME_ROOT }, async t => {
  const f = await fixture(t), a = await f.capture('A\n', 'before'), b = await f.capture('B\n'), alias = await f.capture('B\n', 'before'), c = await f.capture('C\n');
  const first = await f.restore(alias.id); const history = await f.history(), branch = history.tree.nodes.find(node => node.id === first.version.id);
  assert.equal(branch.parentId, b.id); assert.equal(branch.restoredFromId, b.id); assert.equal(branch.kind, 'restored');
  assert.ok(history.tree.nodes.some(node => node.id === c.id)); assert.equal(history.tree.currentId, first.version.id);
  const compared = await f.service.request('compare', { ...f.coordinates, versionId: branch.id });
  assert.ok(compared.changes.some(change => change.before.includes('C') && change.after.includes('B')));
  await f.capture('D\n'); const second = await f.restore(a.id), beforeRestart = await f.history();
  assert.equal(beforeRestart.tree.nodes.find(node => node.id === second.version.id).parentId, a.id);
  await f.restart(); const restarted = await f.history(); assert.deepEqual(restarted.tree, beforeRestart.tree);
  const emptyBefore = await f.service.request('compare', { ...f.coordinates, versionId: branch.id, beforeId: null });
  assert.ok(emptyBefore.changes.every(change => !change.before));
});

test('history detects external changes and deletion without forging a current ancestor or snapshot', { skip: !process.env.RUFA_RUNTIME_ROOT }, async t => {
  const f = await fixture(t); await f.capture('A'); await f.capture('B'); const old = await f.history();
  await writeFile(f.file, 'A'); const changed = await f.history(); assert.equal(changed.tree.currentState, 'changed'); assert.equal(changed.tree.currentId, null);
  assert.deepEqual(changed.tree.nodes, old.tree.nodes);
  await rm(f.file); const missing = await f.history(); assert.equal(missing.tree.currentState, 'missing'); assert.equal(missing.tree.currentId, null);
  assert.deepEqual(missing.tree.nodes, old.tree.nodes);
  await writeFile(f.file, 'B'); assert.equal((await f.history()).tree.currentState, 'recorded');
});

test('summary-only cards skip reading the current file until the version panel opens', { skip: !process.env.RUFA_RUNTIME_ROOT }, async t => {
  const f = await fixture(t); await f.capture('A'); const before = f.currentReads;
  const summary = await f.service.request('history', { ...f.coordinates, summaryOnly: true });
  assert.equal(f.currentReads, before); assert.equal(summary.tree.currentState, 'unavailable'); assert.equal(summary.tree.currentId, null);
  assert.equal(summary.tree.nodes.length, 1);
  const history = await f.history(); assert.equal(f.currentReads, before + 1); assert.equal(history.tree.currentState, 'recorded');
});
