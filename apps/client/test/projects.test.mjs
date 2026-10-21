import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, realpath, readdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { Script } from 'node:vm';
import { spawnSync } from 'node:child_process';
import { createProjectDirectoryPolicy, installProjectRegistryPolicy, isSessionDirectory, apply as applyProjectPolicy } from '../src/runtime/company-project-directories.mjs';
import { rufaOpenIndependent, rufaStartSession, rufaRestoreSelection, rufaProjectRank, rufaProjectPickFlow } from '../src/runtime/projects-ui.mjs';
import { patchProjectSource } from '../scripts/projects-runtime.mjs';
import { importUpstream } from '../src/runtime/import-upstream.mjs';
import { accountRuntimePaths, prepareAccountDirectories } from '../dist/runtime-configuration.js';
const runtime = process.env.RUFA_RUNTIME_ROOT;

async function temp(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rufa-projects-test-')));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), await realpath(tmpdir()));
    assert.ok(basename(root).startsWith('rufa-projects-test-'));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}
async function policyFixture(t) {
  const root = await temp(t), privateRoot = join(root, 'company'), accountHome = join(privateRoot, 'accounts', 'a'.repeat(64));
  const workspaceRoot = join(accountHome, 'workspaces'), runtimeRoot = join(root, 'runtime');
  await mkdir(accountHome, { recursive: true }); await mkdir(runtimeRoot);
  const config = { accountHome, workspaceRoot, privateRoot, runtimeRoot };
  return { root, ...config, config, policy: createProjectDirectoryPolicy(config) };
}
function fakeRegistry() {
  const rows = [];
  return { rows, list: () => rows, resolveByPath: async path => rows.find(row => row.path === path),
    create: async (path, title) => { const row = { id: randomUUID(), path, title, sessionIds: [] }; rows.push(row); return row; },
    delete: async id => { const index = rows.findIndex(row => row.id === id); if (index >= 0) rows.splice(index, 1); } };
}

test('multiple canonical folders persist across policy restart and only explicit project members receive references', async t => {
  const f = await policyFixture(t), registry = fakeRegistry();
  const work = join(f.root, 'work'), reference = join(f.root, 'reference'), alias = join(f.root, 'reference-alias');
  await mkdir(work); await mkdir(reference); await symlink(reference, alias, 'junction');
  await writeFile(join(reference, 'source.txt'), 'reference contents');
  const project = await f.policy.createProject({ title: '多目录{{model}}', path: work, referencePaths: [reference, alias, work] }, registry);
  project.sessionIds.push('in-project');
  const metadata = JSON.parse(await readFile(join(f.accountHome, 'company-project-folders.json'), 'utf8'));
  assert.deepEqual(Object.values(metadata.projects)[0], { workspaceId: project.id, path: await realpath(work), referencePaths: [await realpath(reference)] });
  f.policy.dispose();
  const resumed = createProjectDirectoryPolicy(f.config), session = { id: 'in-project', header: { cwd: project.path } };
  const context = await resumed.projectContext(session, registry);
  assert.equal(context.name, 'company:project-folders'); assert.equal(context.interpolate, false);
  assert.ok(context.text.includes(JSON.stringify(await realpath(reference))));
  assert.ok(context.text.includes('{{model}}'), 'project names cannot interpolate model variables');
  assert.equal(await resumed.projectContext({ ...session, id: 'independent' }, registry), undefined);
  assert.equal(await resumed.projectContext(session, fakeRegistry()), undefined);
  await registry.delete(project.id); assert.equal(await resumed.projectContext(session, registry), undefined);
  assert.equal(await readFile(join(reference, 'source.txt'), 'utf8'), 'reference contents');
});

test('references reject private/runtime/nonexistent paths, deduplicate Windows aliases, and fail closed on redirected or corrupt metadata', async t => {
  const f = await policyFixture(t), registry = fakeRegistry(), reference = join(f.root, 'reference'); await mkdir(reference);
  for (const path of [f.accountHome, f.runtimeRoot, join(f.root, 'missing')]) {
    await assert.rejects(f.policy.createProject({ title: '无效', referencePaths: [path] }, registry));
    assert.equal(registry.rows.length, 0);
  }
  for (const referencePaths of [null, 1, ['relative'], Array(32).fill(reference)]) {
    await assert.rejects(f.policy.createProject({ title: '无效', referencePaths }, registry), /参考文件夹/);
  }
  const project = await f.policy.createProject({ title: '可用', referencePaths: [reference, ...(process.platform === 'win32' ? [reference.toUpperCase()] : [])] }, registry);
  project.sessionIds.push('s'); const session = { id: 's', header: { cwd: project.path } };
  const metadataPath = join(f.accountHome, 'company-project-folders.json');
  const saved = await readFile(metadataPath, 'utf8');
  assert.equal(Object.values(JSON.parse(saved).projects)[0].referencePaths.length, 1);
  await rm(reference, { recursive: true }); await symlink(f.accountHome, reference, 'junction');
  const context = await f.policy.projectContext(session, registry);
  const facts = JSON.parse(context.text.split('\n')[1]);
  assert.deepEqual(facts.referenceDirectories, []); assert.deepEqual(facts.unavailableReferences, [reference]);
  await writeFile(metadataPath, '{broken'); await assert.rejects(f.policy.projectContext(session, registry));
  await writeFile(metadataPath, saved);
  const otherAccount = join(f.privateRoot, 'accounts', 'b'.repeat(64), 'workspaces/projects/foreign'); await mkdir(otherAccount, { recursive: true });
  registry.rows.push({ id: 'foreign', path: otherAccount, sessionIds: ['foreign-session'] });
  assert.equal(await f.policy.projectContext({ id: 'foreign-session', header: { cwd: otherAccount } }, registry), undefined);
});

test('failed metadata commit rolls back new registry without touching selected files; unbound records stay inert after a crash', async t => {
  const f = await policyFixture(t), registry = fakeRegistry(), work = join(f.root, 'work'); await mkdir(work);
  await writeFile(join(work, 'original.txt'), 'keep');
  const metadataPath = join(f.accountHome, 'company-project-folders.json');
  const create = registry.create, remove = registry.delete;
  registry.create = async (...args) => {
    const row = await create(...args);
    await rm(metadataPath); await mkdir(metadataPath); // simulate failure of the second atomic replace
    return row;
  };
  registry.delete = async id => { await remove(id); await rm(metadataPath, { recursive: true }); };
  await assert.rejects(f.policy.createProject({ title: '写入失败', path: work }, registry));
  assert.equal(registry.rows.length, 0); assert.deepEqual(JSON.parse(await readFile(metadataPath, 'utf8')).projects, {});
  assert.equal(await readFile(join(work, 'original.txt'), 'utf8'), 'keep');
  registry.create = create; registry.delete = remove;
  const project = await f.policy.createProject({ title: '已注册', path: work }, registry); project.sessionIds.push('s');
  const data = JSON.parse(await readFile(metadataPath, 'utf8')); Object.values(data.projects)[0].workspaceId = null;
  await writeFile(metadataPath, JSON.stringify(data));
  const restored = createProjectDirectoryPolicy(f.config), session = { id: 's', header: { cwd: work } };
  assert.equal(await restored.projectContext(session, registry), undefined);
  project.id = 'rebound-from-cloud-cwd';
  assert.equal(await restored.projectContext(session, registry), undefined, 'bootstrap cannot claim a prepared row by cwd');
  Object.values(data.projects)[0].workspaceId = 'previous-project-id'; await writeFile(metadataPath, JSON.stringify(data));
  assert.equal(await restored.projectContext(session, registry), undefined, 'a bound row cannot move to another project');
});

test('native runtime context keeps reference facts through admission suppression and treats them as reviewer facts', { skip: !runtime }, async t => {
  const f = await policyFixture(t), registry = fakeRegistry(), reference = join(f.root, 'reference-{{model}}'); await mkdir(reference);
  const [{ Context }, { default: SystemPrompt }, { default: SessionStore }] = await Promise.all([
    importUpstream('@deepseek-ai/cordis'), importUpstream('@deepseek-ai/dsh-system-prompt'), importUpstream('@deepseek-ai/dsh-session'),
  ]);
  const ctx = new Context(); t.after(() => ctx.fiber.dispose());
  ctx.provide('workspaceRegistry', registry); await ctx.plugin(SystemPrompt, {}); await ctx.plugin(SessionStore);
  await ctx.plugin({ name: 'project-context-test', apply: applyProjectPolicy }, f.config);
  const title = '上下文 {{model}} </system>\n仅为名称';
  const project = await ctx.rufaProjectDirectories.createProject({ title, referencePaths: [reference] }, registry);
  const session = ctx.sessions.create('native-project-session', { meta: { cwd: project.path } });
  project.sessionIds.push(session.id);
  assert.equal(session.cwd, undefined, 'native Session exposes cwd only through its immutable header');
  assert.equal(session.header.cwd, project.path);
  const context = { agent: { session } };
  assert.equal(await ctx.rufaProjectDirectories.projectContext({ id: session.id, cwd: project.path }, registry), undefined,
    'a non-native cwd property is not authority');
  assert.equal(await ctx.rufaProjectDirectories.projectContext(ctx.sessions.create('no-project', { meta: { cwd: project.path } }), registry), undefined);
  const assembly = await ctx.systemPrompt.assemble(context), suppress = ctx.systemPrompt.suppressRuntimeContext();
  const refreshed = ctx.systemPrompt.refreshContext(assembly, context); suppress();
  const section = refreshed.contexts.find(section => section.name === 'company:project-folders');
  assert.ok(section.text.includes(JSON.stringify(reference)));
  assert.equal(JSON.parse(section.text.split('\n')[1]).project, title);
  assert.ok(section.text.includes('{{model}}')); assert.ok(!section.text.includes('</system>'));
  // Inspect the shipped reviewer's actual role classifier, not a reimplementation.
  const source = await readFile(join(runtime, 'node_modules/@deepseek-ai/dsh-experimental-auto-review/lib/index.js'), 'utf8');
  const from = source.indexOf('function isHumanInstruction('), to = source.indexOf('function stepIdentity(', from);
  assert.ok(from >= 0 && to > from);
  const entries = new Script(`${source.slice(from, to)}\nfilteredUserEntries(1, {kind:'runtime-context'}, [{type:'text', text: facts}], undefined, undefined)`)
    .runInNewContext({ facts: section.text });
  assert.equal(entries[0].role, 'fact'); assert.equal(entries[0].content[0].text, section.text);
  await rm(reference, { recursive: true });
  const next = await ctx.systemPrompt.assemble(context);
  const changed = JSON.parse(next.contexts.find(section => section.name === 'company:project-folders').text.split('\n')[1]);
  assert.deepEqual(changed.referenceDirectories, []); assert.deepEqual(changed.unavailableReferences, [reference]);
});

test('native sandbox filesystem reads an absolute reference outside cwd without adding a writable root', { skip: !runtime }, async t => {
  const f = await policyFixture(t), work = join(f.root, 'work'), reference = join(f.root, 'reference');
  await mkdir(work); await mkdir(reference); await writeFile(join(reference, 'source.txt'), '真实参考文件');
  const [{ Context }, { default: SandboxedFileSystem }] = await Promise.all([
    importUpstream('@deepseek-ai/cordis'), importUpstream('@deepseek-ai/dsh-fs-sandbox'),
  ]);
  const ctx = new Context(); t.after(() => ctx.fiber.dispose());
  ctx.provide('sandboxPolicy', { defaultMode: 'read-only', resolve: () => ({ mode: 'read-only', workspaceRoot: work }) });
  await ctx.plugin(SandboxedFileSystem, { cwd: work });
  const target = await ctx.fs.resolve(join(reference, 'source.txt'), { cwd: work });
  assert.equal(await ctx.fs.readText(target), '真实参考文件');
  await assert.rejects(ctx.fs.writeText(target, 'unauthorized'), /read-only/);
  assert.equal(await readFile(join(reference, 'source.txt'), 'utf8'), '真实参考文件');
});

test('unassigned directories are distinct; project creation shares only an explicitly registered writable directory', async t => {
  const { root, policy, workspaceRoot } = await policyFixture(t), registry = fakeRegistry();
  const [first, second] = await Promise.all([policy.allocateSessionDirectory(), policy.allocateSessionDirectory()]);
  assert.notEqual(first, second); assert.equal(dirname(first), join(workspaceRoot, 'sessions'));
  assert.ok(isSessionDirectory(first)); assert.equal(registry.rows.length, 0);
  const project = await policy.createProject({ title: '生产排程', path: '' }, registry);
  assert.equal(dirname(project.path), join(workspaceRoot, 'projects')); assert.equal(project.title, '生产排程');
  const external = join(root, 'office'); await mkdir(external); await writeFile(join(external, 'keep.txt'), 'original');
  const chosen = await policy.createProject({ title: '客户资料', path: external }, registry);
  assert.equal(chosen.path, await realpath(external)); assert.equal(await readFile(join(external, 'keep.txt'), 'utf8'), 'original');
  await assert.rejects(policy.createProject({ title: '错误重命名', path: external }, registry), /已经属于/);
  assert.equal(chosen.title, '客户资料');
  await assert.rejects(policy.createProject({ title: '生产排程' }, registry), /同名/);
  await assert.rejects(policy.createProject({ title: '会话共享', path: first }, registry), /独立会话/);
  policy.dispose(); await assert.rejects(policy.allocateSessionDirectory(), /关闭/);
});

test('selected private, other-account and runtime paths are rejected before writing any probe', async t => {
  const f = await policyFixture(t), registry = fakeRegistry();
  const other = join(f.privateRoot, 'accounts', 'b'.repeat(64));
  const secrets = join(f.accountHome, 'profiles');
  await mkdir(other, { recursive: true }); await mkdir(secrets);
  for (const target of [f.privateRoot, f.accountHome, secrets, other, f.runtimeRoot, f.root]) {
    const before = await readdir(target);
    await assert.rejects(f.policy.createProject({ title: '禁止目录', path: target }, registry), /私有|运行环境/);
    // accountRoot may only create its own workspaces, never write into a rejected target.
    const after = await readdir(target);
    assert.deepEqual(after.filter(name => name !== 'workspaces'), before.filter(name => name !== 'workspaces'));
  }
  const alias = join(f.root, 'alias'); await symlink(other, alias, 'junction');
  await assert.rejects(f.policy.createProject({ title: '别名', path: alias }, registry), /私有/);
  assert.deepEqual(await readdir(other), []); assert.equal(registry.rows.length, 0);
});

test('allocator refuses root and parent junction redirects before creating outside directories', async t => {
  const f = await policyFixture(t), outside = join(f.root, 'outside'); await mkdir(outside);
  await symlink(outside, f.workspaceRoot, 'junction');
  await assert.rejects(f.policy.allocateSessionDirectory(), /重定向/);
  assert.deepEqual(await readdir(outside), []);
  const anotherHome = join(f.privateRoot, 'accounts', 'c'.repeat(64)), anotherRoot = join(anotherHome, 'workspaces');
  await mkdir(anotherRoot, { recursive: true }); await symlink(outside, join(anotherRoot, 'sessions'), 'junction');
  const policy = createProjectDirectoryPolicy({ ...f.config, accountHome: anotherHome, workspaceRoot: anotherRoot });
  await assert.rejects(policy.allocateSessionDirectory(), /重定向/);
  assert.deepEqual(await readdir(outside), []);
});

test('project registry mode stops default creation but preserves every legacy registration', async () => {
  const rows = [{ id: 'default', path: '/legacy/default-workspace', title: '旧默认' },
    { id: 'reserved-looking', path: `/accounts/${'a'.repeat(64)}/workspaces/sessions/${randomUUID()}`, title: '显式旧项目' }];
  let initialized = 0;
  const registry = { list: () => rows, initializeDefault: async () => { initialized++; return rows[0]; }, delete() { throw new Error('Must preserve registered projects'); } };
  const before = registry.initializeDefault, policy = await installProjectRegistryPolicy(registry);
  assert.equal(await registry.initializeDefault(), undefined); assert.equal(initialized, 0); assert.equal(rows.length, 2);
  policy.dispose(); assert.equal(registry.initializeDefault, before);
  assert.equal(isSessionDirectory(`/external/workspaces/sessions/${randomUUID()}`), false);
  assert.equal(isSessionDirectory(`D:\\some-device\\accounts\\${'b'.repeat(64)}\\workspaces\\sessions\\${randomUUID()}`), true);
});

test('Harness preparation rejects account or workspace redirects before creating profile and overlay paths', async t => {
  const root = await temp(t), accounts = join(root, 'accounts'), outside = join(root, 'outside');
  await mkdir(accounts); await mkdir(outside);
  const a = accountRuntimePaths(accounts, 'https://company.example', 'a');
  await symlink(outside, a.companyHome, 'junction');
  await assert.rejects(prepareAccountDirectories(accounts, a), /重定向/);
  assert.deepEqual(await readdir(outside), []);
  const b = accountRuntimePaths(accounts, 'https://company.example', 'b');
  await mkdir(b.companyHome); await symlink(outside, join(b.companyHome, 'workspaces'), 'junction');
  await assert.rejects(prepareAccountDirectories(accounts, b), /重定向/);
  assert.deepEqual(await readdir(outside), []);
  assert.deepEqual(await readdir(b.companyHome), ['workspaces']);
});

function navigationHarness() {
  const creations = [], selected = [], drafts = [], projectCalls = [];
  const lifetime = new AbortController();
  const nav = {
    ctx: { layout: { beginNavigation: () => new AbortController().signal } }, lifetime,
    sessions: { create: async request => { creations.push(request); return `new-${creations.length}`; }, binding: id => ({ id }) },
    replaceMain: (id, signal, mode, beforeOpen) => { signal.throwIfAborted(); beforeOpen?.(id); selected.push({ id, mode }); },
    prepareDraft: (binding, options) => drafts.push({ binding, options }), draftPreparationFailed: () => { throw new Error('draft missing'); },
    notify: () => {}, openWorkspaceSession: async (...args) => { projectCalls.push(args); }, openWorkspace: async (...args) => { projectCalls.push(args); },
    selection: { getSnapshot: () => ({}) },
  };
  nav.rufaOpenIndependent = rufaOpenIndependent.bind(nav);
  return { nav, creations, selected, drafts, projectCalls };
}

test('global new ignores current projects while explicit project creation and native draft callbacks remain available', async () => {
  const h = navigationHarness();
  await rufaOpenIndependent.call(h.nav, { prompt: '保留文字', clearPreviousDraft: false, agentPreset: 'standard' });
  await rufaOpenIndependent.call(h.nav, undefined, id => h.drafts.push({ transferredTo: id }));
  assert.deepEqual(h.creations, [{ agentPreset: 'standard' }, {}]);
  assert.equal(h.drafts[0].options.prompt, '保留文字'); assert.equal(h.drafts[1].transferredTo, 'new-2');
  rufaStartSession.call(h.nav, 'project-1');
  assert.deepEqual(h.projectCalls, [['project-1', undefined, undefined]]);
  assert.equal(h.creations.length, 2);
});

test('startup restores cold history and an existing independent blank without selecting the recent project', async () => {
  const h = navigationHarness(), projects = { items: [{ workspaceId: 'project', sessionIds: ['in-project'] }], archivedSessionIds: [] };
  const list = { ids: ['independent', 'in-project'], byId: { independent: { id: 'independent', blank: true }, 'in-project': { id: 'in-project', blank: true } } };
  await rufaRestoreSelection.call(h.nav, projects, list);
  assert.equal(h.selected.at(-1).id, 'independent'); assert.equal(h.creations.length, 0);
  h.nav.selection.getSnapshot = () => ({ sessionId: 'in-project' });
  await rufaRestoreSelection.call(h.nav, projects, list);
  assert.equal(h.selected.at(-1).id, 'in-project'); assert.equal(h.creations.length, 0);
  h.nav.selection.getSnapshot = () => ({});
  await rufaRestoreSelection.call(h.nav, projects, { ids: [], byId: {} });
  assert.deepEqual(h.creations, [{}]);
  assert.equal(rufaProjectRank({ createdAt: '2020-01-01', updatedAt: '2020-01-02', sessionIds: ['a'] }, { a: { updatedAt: 2000000000000 } }), 2000000000000);
});

test('discarding an unused project blank cannot outrank a newer project while real conversation activity still can', () => {
  const projects = [1, 2, 3, 4].map(day => ({ id: String(day), createdAt: `2026-10-0${day}T00:00:00Z`,
    updatedAt: `2026-10-0${day}T00:00:00Z`, sessionIds: [`session-${day}`] }));
  const summaries = Object.fromEntries(projects.map(project => [project.sessionIds[0], { updatedAt: Date.parse(project.createdAt) + 1000 }]));
  const order = () => [...projects].sort((a, b) => rufaProjectRank(b, summaries) - rufaProjectRank(a, summaries)).map(project => project.id);
  assert.deepEqual(order(), ['4', '3', '2', '1']);
  // Native detach writes a fresh registry timestamp, after project 4 exists.
  projects[2].sessionIds = []; projects[2].updatedAt = '2026-10-19T00:00:00Z'; delete summaries['session-3'];
  assert.deepEqual(order(), ['4', '3', '2', '1']);
  assert.equal(rufaProjectRank(projects[2], summaries), Date.parse(projects[2].createdAt));
  summaries['session-2'].updatedAt = Date.parse('2026-10-20T00:00:00Z');
  assert.deepEqual(order(), ['2', '4', '3', '1']);
});

test('all pinned runtime patches parse, replay identically and reject partial modifications', { skip: !runtime }, async t => {
  const root = await temp(t);
  for (const [kind, file] of [['registry', 'dsh-workspace/lib/index.js'], ['session', 'dsh-api-session-controller/lib/index.js'],
    ['controller', 'dsh-api-workspace-controller/lib/index.js'], ['browser', 'dsh-client-ui-workspace/lib/client.js'], ['conversation', 'dsh-client-ui-conversation/lib/client.js'],
    ['host-codec', 'dsh-api-workspace-controller/lib/typert.host.js'], ['remote-codec', 'dsh-api-workspace-controller/lib/typert.remote-client.js'], ['remotes-browser', 'dsh-api-remotes/lib/client.js']]) {
    const source = await readFile(join(runtime, 'node_modules/@deepseek-ai', file), 'utf8'), patched = patchProjectSource(source, kind);
    assert.equal(patchProjectSource(patched, kind), patched);
    assert.throws(() => patchProjectSource(patched.replace('Rufajx projects v1', 'Rufajx projects v1 changed'), kind), /incomplete|modified/);
    if (kind === 'browser' || kind === 'conversation' || kind === 'remotes-browser') new Script(patched);
    else {
      const target = join(root, `${kind}.mjs`); await writeFile(target, patched);
      const syntax = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8', windowsHide: true });
      assert.equal(syntax.status, 0, syntax.stderr);
    }
  }
});

test('a verified prior browser bundle upgrades only its activity rank and rejects unknown or damaged implementations', { skip: !runtime }, async () => {
  const source = await readFile(join(runtime, 'node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js'), 'utf8');
  const current = patchProjectSource(source, 'browser');
  const trailer = /\n\/\/ Rufajx projects integrity: ([a-f0-9]{64})\n?$/;
  const body = current.slice(0, current.match(trailer).index);
  const start = body.indexOf('function rufaProjectRank(workspace, summaries) {');
  const end = body.indexOf('\nfunction WorkspaceBrowser({', start);
  const rank = body.slice(start, end);
  assert.equal(rank.replaceAll('\r\n', '\n'), rufaProjectRank.toString().replaceAll('\r\n', '\n'));
  const legacy = `function rufaProjectRank(workspace, summaries) {
  return Math.max(Date.parse(workspace.updatedAt || workspace.createdAt) || 0,
    ...workspace.sessionIds.map(id => summaries[id]?.updatedAt ?? 0));
}`;
  const sign = value => `${value}\n// Rufajx projects integrity: ${createHash('sha256').update(value).digest('hex')}\n`;
  for (const previous of [legacy, legacy.replaceAll('\n', '\r\n')]) {
    const old = sign(body.slice(0, start) + previous + body.slice(end));
    const upgraded = patchProjectSource(old, 'browser');
    const expected = sign(body.slice(0, start) + rufaProjectRank.toString().replaceAll('\r\n', '\n') + body.slice(end));
    assert.equal(upgraded, expected, 'all bytes outside the one rank function and integrity trailer stay identical');
    assert.equal(patchProjectSource(upgraded, 'browser'), upgraded);
    new Script(upgraded);
    assert.throws(() => patchProjectSource(old.replace('workspace.updatedAt ||', 'unknown.updatedAt ||'), 'browser'), /incomplete|modified/);
  }
  const unknown = sign(body.slice(0, start) + 'function rufaProjectRank(workspace, summaries) { return 1; }' + body.slice(end));
  assert.throws(() => patchProjectSource(unknown, 'browser'), /Unknown company project activity rank/);
  assert.throws(() => patchProjectSource(sign(body.slice(0, start) + body.slice(end)), 'browser'), /anchors changed/);
});

test('published project picker upgrades without changing other native code and refuses unrecognized dialog edits', { skip: !runtime }, async () => {
  const source = await readFile(join(runtime, 'node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js'), 'utf8');
  const current = patchProjectSource(source, 'browser');
  const trailer = /\n\/\/ Rufajx projects integrity: ([a-f0-9]{64})\n?$/;
  const body = current.slice(0, current.match(trailer).index);
  const from = body.indexOf('function WorkspacePickFlow({');
  const to = body.indexOf('\n\n\t\t/**\n\t\t* The conversation empty-state registration:', from);
  assert(from >= 0 && to > from);
  const oldFlow = await readFile(new URL('./fixtures/project-pick-flow-v2.txt', import.meta.url), 'utf8');
  assert.equal(createHash('sha256').update(oldFlow).digest('hex'), '9df75b2f6d77652c0b3f452c4f6b83e3d5a53161efc516f8bf6d6ac21d0c6aa2');
  const sign = value => `${value}\n// Rufajx projects integrity: ${createHash('sha256').update(value).digest('hex')}\n`;
  for (const published of [oldFlow, oldFlow.replaceAll('\n', '\r\n')]) {
    const previous = sign(body.slice(0, from) + published + body.slice(to));
    const upgraded = patchProjectSource(previous, 'browser');
    assert.equal(upgraded, current, 'Only the known picker function and integrity trailer change');
    assert.equal(patchProjectSource(upgraded, 'browser'), upgraded);
    new Script(upgraded);
    assert.throws(() => patchProjectSource(previous.replace("title: '创建项目'", "title: 'unknown'"), 'browser'), /incomplete|modified/);
  }
  const unknownFlow = oldFlow.replace("title: '创建项目'", "title: 'unknown'");
  assert.throws(() => patchProjectSource(sign(body.slice(0, from) + unknownFlow + body.slice(to)), 'browser'), /Unknown company project dialog/);
  assert.equal(body.slice(from, to), rufaProjectPickFlow.toString().replace('rufaProjectPickFlow', 'WorkspacePickFlow').replaceAll('\r\n', '\n'));
});

test('real generated host and remote strict codecs preserve and validate the project title', { skip: !runtime }, async t => {
  const root = await temp(t), req = createRequire(join(runtime, 'package.json'));
  for (const name of ['zod', '@deepseek-ai/dsh-typert-protocol']) {
    const target = join(root, 'node_modules', name); await mkdir(dirname(target), { recursive: true });
    await symlink(dirname(req.resolve(`${name}/package.json`)), target, 'junction');
  }
  for (const [kind, file] of [['host-codec', 'typert.host.js'], ['remote-codec', 'typert.remote-client.js']]) {
    const source = await readFile(join(runtime, 'node_modules/@deepseek-ai/dsh-api-workspace-controller/lib', file), 'utf8');
    const target = join(root, `${kind}.mjs`); await writeFile(target, patchProjectSource(source, kind));
    const module = await import(pathToFileURL(target).href);
    const descriptor = (module.TYPERT?.invocations ?? module.TYPERT_REMOTE?.descriptors)?.find(row => row.namespace === 'workspace' && row.method === 'create');
    assert.ok(descriptor, 'real published generated workspace/create descriptor');
    for (const schema of [descriptor.parameters[0].codec, descriptor.parameters[0].strictCodec]) {
      assert.deepEqual(schema.create().parse({ path: '', title: '生产排程' }), { path: '', title: '生产排程' });
      assert.deepEqual(schema.create().parse({ path: 'C:/work', title: '资料', referencePaths: ['C:/reference'] }),
        { path: 'C:/work', title: '资料', referencePaths: ['C:/reference'] });
      for (const referencePaths of [null, 'folder', [123], Array(32).fill('C:/ref')]) {
        assert.throws(() => schema.create().parse({ path: '', title: '资料', referencePaths }));
      }
      assert.throws(() => schema.create().parse({ path: '' }));
      assert.throws(() => schema.create().parse({ path: '', title: 'x'.repeat(101) }));
      assert.deepEqual(schema.jsonSchema.required, ['path', 'title']);
    }
  }
});

test('real registry bootstrap excludes independent paths from two devices and retains registered legacy projects after restart', { skip: !runtime }, async t => {
  const root = await temp(t), moduleRoot = join(root, 'module'); await mkdir(moduleRoot);
  const req = createRequire(join(runtime, 'package.json'));
  for (const name of ['@deepseek-ai/cordis', 'zod', '@deepseek-ai/dsh-brand', '@deepseek-ai/dsh-storage-domain']) {
    const target = join(moduleRoot, 'node_modules', name); await mkdir(dirname(target), { recursive: true });
    await symlink(dirname(req.resolve(`${name}/package.json`)), target, 'junction');
  }
  await writeFile(join(moduleRoot, 'package.json'), '{"type":"module"}');
  const registrySource = await readFile(join(runtime, 'node_modules/@deepseek-ai/dsh-workspace/lib/index.js'), 'utf8');
  await writeFile(join(moduleRoot, 'registry.mjs'), patchProjectSource(registrySource, 'registry'));
  const [{ default: Registry }, { Context }, { default: Storage }, sqlite, domain, session] = await Promise.all([
    import(pathToFileURL(join(moduleRoot, 'registry.mjs')).href), importUpstream('@deepseek-ai/cordis'), importUpstream('@deepseek-ai/dsh-storage'),
    importUpstream('@deepseek-ai/dsh-storage-sqlite'), importUpstream('@deepseek-ai/dsh-storage-domain'), importUpstream('@deepseek-ai/dsh-session'),
  ]);
  const legacy = join(root, 'legacy-default'), standalone = join(root, 'device-a/accounts', 'a'.repeat(64), 'workspaces/sessions', randomUUID());
  const foreign = join(root, 'device-b/accounts', 'b'.repeat(64), 'workspaces/sessions', randomUUID());
  for (const path of [legacy, standalone, foreign]) await mkdir(path, { recursive: true });
  await writeFile(join(legacy, 'keep.txt'), 'original');
  const headers = [legacy, standalone, foreign].map((cwd, i) => ({ id: `history-${i}`, version: session.SESSION_FORMAT_VERSION, createdAt: i + 1, isSeeded: false, cwd }));
  const before = structuredClone(headers), live = new Set();
  async function boot(database) {
    const ctx = new Context(); live.add(ctx);
    await ctx.plugin(Storage); await ctx.plugin(sqlite, { path: join(root, `${database}.sqlite`), journalMode: 'wal' });
    await ctx.plugin(domain, { backend: 'sqlite' });
    ctx.provide('rufaProjectDirectories', { isSessionDirectory });
    ctx.provide('sessionPersistence', { list: async () => headers.map(header => ({ header, revision: 'test' })), open() { throw new Error('Do not open history'); } });
    ctx.provide('sessions', { list: () => [], get: () => undefined }); await ctx.plugin(Registry);
    return ctx;
  }
  async function stop(ctx) { await ctx.fiber.dispose(); live.delete(ctx); }
  try {
    let ctx = await boot('registry');
    assert.deepEqual(ctx.workspaceRegistry.list().map(row => row.path), [await realpath(legacy)]);
    const explicit = await ctx.workspaceRegistry.create(standalone, '以前显式注册的项目');
    const legacyPath = await realpath(legacy), legacyId = ctx.workspaceRegistry.list().find(row => row.path === legacyPath).id;
    const policy = await installProjectRegistryPolicy(ctx.workspaceRegistry);
    assert.equal(ctx.workspaceRegistry.list().length, 2); assert.equal(await ctx.workspaceRegistry.initializeDefault(), undefined);
    policy.dispose(); await stop(ctx);
    ctx = await boot('registry');
    assert.equal(ctx.workspaceRegistry.get(explicit.id).title, '以前显式注册的项目'); assert.ok(ctx.workspaceRegistry.get(legacyId));
    await stop(ctx);
    ctx = await boot('rebuilt');
    assert.equal(ctx.workspaceRegistry.list().length, 1); assert.equal(await readFile(join(legacy, 'keep.txt'), 'utf8'), 'original');
    assert.deepEqual(headers, before); await stop(ctx);
  } finally { for (const ctx of live) await ctx.fiber.dispose(); }
});
