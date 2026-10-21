import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { apply, installCompanyWorkspace } from '../src/runtime/company-workspace.mjs';
import { importUpstream } from '../src/runtime/import-upstream.mjs';

test('company workspaces use the real registry and durable SQLite without moving history', { skip: !process.env.RUFA_RUNTIME_ROOT }, async t => {
  const [{ Context }, { default: Storage }, sqlite, domain, { default: WorkspaceRegistry }, session] = await Promise.all([
    importUpstream('@deepseek-ai/cordis'), importUpstream('@deepseek-ai/dsh-storage'),
    importUpstream('@deepseek-ai/dsh-storage-sqlite'), importUpstream('@deepseek-ai/dsh-storage-domain'),
    importUpstream('@deepseek-ai/dsh-workspace'), importUpstream('@deepseek-ai/dsh-session'),
  ]);
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'rufa-company-workspace-')));
  const liveContexts = new Set();
  const histories = new Map();
  async function boot(account) {
    const accountHome = join(temporary, account);
    const ctx = new Context(); liveContexts.add(ctx);
    await ctx.plugin(Storage);
    await ctx.plugin(sqlite, { path: join(accountHome, 'workspace.sqlite'), journalMode: 'wal' });
    await ctx.plugin(domain, { backend: 'sqlite' });
    const headers = histories.get(account) ?? []; histories.set(account, headers);
    ctx.provide('sessionPersistence', {
      list: async () => headers.map(header => ({ header, revision: `rev-${header.id}` })),
      open: () => { throw new Error('Workspace policy must not open or rewrite Session bodies'); },
    });
    ctx.provide('sessions', { list: () => [], get: () => undefined });
    await ctx.plugin(WorkspaceRegistry);
    return { ctx, registry: ctx.workspaceRegistry, headers, root: join(accountHome, 'workspaces/default') };
  }
  async function stop(harness) { await harness.ctx.fiber.dispose(); liveContexts.delete(harness.ctx); }
  async function install(harness) {
    await harness.ctx.plugin({ name: 'workspace-company-test', inject: ['workspaceRegistry'], apply }, { workspaceRoot: harness.root });
    assert.ok(harness.ctx.get('rufaWorkspaceReady'), 'startup gate is published after active initialization');
    return harness.ctx.get('rufaWorkspaceReady');
  }
  try {
    await t.test('startup creates one account default, concurrent calls and restart retain its identity', async () => {
      let a = await boot('employee-a');
      const ready = await install(a);
      assert.equal(a.registry.list().length, 1, 'created proactively without any UI initializeDefault call');
      const selected = a.registry.get(ready.workspaceId);
      assert.equal(selected.path, await realpath(a.root));
      assert.equal(selected.title, 'Rufajx默认工作区');
      const calls = await Promise.all(Array.from({ length: 6 }, () => a.registry.initializeDefault(async () => { throw new Error('shared resolver called'); })));
      assert.ok(calls.every(workspace => workspace.id === selected.id));
      await stop(a);
      a = await boot('employee-a'); await install(a);
      assert.equal((await a.registry.initializeDefault()).id, selected.id);
      assert.equal(a.registry.get(selected.id).title, 'Rufajx默认工作区');
      assert.equal(a.registry.list().length, 1);
      await stop(a);
      const b = await boot('employee-b'); const bReady = await install(b);
      const bWorkspace = b.registry.get(bReady.workspaceId);
      assert.notEqual(bWorkspace.path, selected.path);
      assert.equal(bWorkspace.title, 'Rufajx默认工作区');
      assert.notEqual(bWorkspace.id, selected.id);
      assert.equal(b.registry.list().length, 1);
      await stop(b);
    });

    await t.test('legacy default registration, explicit workspace and immutable Session cwd remain unchanged', async () => {
      let h = await boot('legacy');
      const shared = join(temporary, 'legacy-documents/deepseek-harness/default-workspace');
      const previous = await h.registry.initializeDefault(async () => shared);
      await writeFile(join(shared, 'existing-office-document.txt'), 'original document');
      h.headers.push({ id: 'historical-session', version: session.SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false, cwd: shared });
      await previous.attachSession('historical-session');
      const explicitPath = join(temporary, 'explicit-user-workspace'); await mkdir(explicitPath);
      const explicit = await h.registry.create(explicitPath, 'User-chosen title');
      const originalHeader = structuredClone(h.headers[0]);
      await stop(h);
      h = await boot('legacy'); const ready = await install(h);
      const current = h.registry.get(ready.workspaceId);
      assert.notEqual(current.id, previous.id);
      assert.equal(current.path, await realpath(h.root));
      assert.equal(h.registry.get(previous.id).path, await realpath(shared));
      assert.equal(h.registry.get(previous.id).title, '历史默认工作区');
      assert.deepEqual(h.registry.get(previous.id).sessionIds, ['historical-session']);
      assert.equal(h.registry.get(explicit.id).title, 'User-chosen title');
      assert.deepEqual(h.headers[0], originalHeader);
      assert.equal(await readFile(join(shared, 'existing-office-document.txt'), 'utf8'), 'original document');
      assert.deepEqual(await readdir(h.root), [], 'old default contents are not copied into the account directory');
      const marker = JSON.parse(await readFile(join(dirname(h.root), '.rufa-default-workspace.json'), 'utf8'));
      assert.equal(marker.workspaceId, current.id);
      assert.equal(marker.previousDefaultWorkspaceId, previous.id);
      await stop(h);
      h = await boot('legacy'); await install(h);
      assert.equal((await h.registry.initializeDefault()).id, current.id);
      assert.equal(h.registry.get(previous.id).title, '历史默认工作区');
      assert.equal(h.registry.list().length, 3);
      await stop(h);
    });

    await t.test('a renamed historical default and an unrelated automatic-looking title are preserved', async () => {
      const h = await boot('custom-title');
      const previous = await h.registry.initializeDefault(async () => join(temporary, 'custom-history/default-workspace'));
      await previous.setTitle('My office records');
      const explicitPath = join(temporary, 'explicit-default-title'); await mkdir(explicitPath);
      const explicit = await h.registry.create(explicitPath, 'default-workspace');
      await install(h);
      assert.equal(h.registry.get(previous.id).title, 'My office records');
      assert.equal(h.registry.get(explicit.id).title, 'default-workspace');
      await stop(h);
    });

    await t.test('an interrupted legacy-title write resumes from the durable marker on restart', async () => {
      let h = await boot('rename-retry');
      const oldRoot = join(temporary, 'retry-history/default-workspace');
      const previous = await h.registry.initializeDefault(async () => oldRoot);
      const originalSetTitle = previous.setTitle;
      previous.setTitle = async () => { throw new Error('simulated historical title write failure'); };
      const policy = installCompanyWorkspace(h.registry, { workspaceRoot: h.root });
      await assert.rejects(policy.ready, /simulated historical title write failure/);
      const marker = JSON.parse(await readFile(join(dirname(h.root), '.rufa-default-workspace.json'), 'utf8'));
      assert.equal(marker.previousDefaultWorkspaceId, previous.id);
      previous.setTitle = originalSetTitle;
      assert.equal(previous.title, 'default-workspace');
      await policy.dispose(); await stop(h);
      h = await boot('rename-retry'); await install(h);
      assert.equal((await h.registry.initializeDefault()).id, marker.workspaceId);
      assert.equal(h.registry.get(previous.id).title, '历史默认工作区');
      assert.equal(h.registry.get(previous.id).path, await realpath(oldRoot));
      assert.equal(h.registry.list().length, 2);
      await stop(h);
    });

    await t.test('corrupt marker fails closed, keeps history and never falls back to a shared directory', async () => {
      const h = await boot('corrupt');
      await mkdir(dirname(h.root), { recursive: true });
      const file = join(dirname(h.root), '.rufa-default-workspace.json'); await writeFile(file, '{invalid');
      const rawRegistry = h.registry[Symbol.for('cordis.original')] ?? h.registry;
      const original = rawRegistry.initializeDefault;
      const installed = installCompanyWorkspace(h.registry, { workspaceRoot: h.root });
      await assert.rejects(installed.ready, /标识文件损坏/);
      await assert.rejects(h.registry.initializeDefault(async () => { throw new Error('must not call legacy resolver'); }), /标识文件损坏/);
      assert.equal(h.registry.list().length, 0);
      assert.equal(await readFile(file, 'utf8'), '{invalid');
      await installed.dispose();
      assert.equal(rawRegistry.initializeDefault, original);
      await stop(h);
    });

    await t.test('deleting the private default registration does not silently recreate it on restart', async () => {
      let h = await boot('deleted'); const ready = await install(h);
      await h.registry.delete(ready.workspaceId);
      await stop(h);
      h = await boot('deleted'); await install(h);
      assert.equal(await h.registry.initializeDefault(), undefined);
      assert.equal(h.registry.list().length, 0);
      await stop(h);
    });
    t.diagnostic(`Real upstream workspace registry, SQLite restart and marker checks used isolated directory: ${temporary}`);
  } finally {
    for (const ctx of liveContexts) await ctx.fiber.dispose();
  }
});
