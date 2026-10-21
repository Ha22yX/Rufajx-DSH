import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { AsyncLocalStorage } from 'node:async_hooks';
import { runInNewContext } from 'node:vm';
import { spawnSync } from 'node:child_process';
import { createSidebarGuard, patchSidebarSource, patchSidebarClientSource, applySidebarCompatibility } from '../scripts/sidebar-compat.mjs';

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(tmpdir(), 'rufa-sidebar-security-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const privateRoot = path.join(temp, 'private'), home = path.join(privateRoot, 'accounts', 'alice');
  const workspace = path.join(home, 'workspaces', 'default'), other = path.join(privateRoot, 'accounts', 'bob');
  const outside = path.join(temp, 'outside'), runtime = path.join(temp, 'runtime');
  for (const dir of [workspace, other, outside, runtime]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'note.txt'), 'ours');
  fs.writeFileSync(path.join(other, 'history.sqlite'), 'not ours');
  const environment = { DSH_HOME: home, RUFA_RUNTIME_ROOT: runtime };
  const forbidden = message => Object.assign(new Error(message), { code: 'forbidden', status: 403 });
  const guard = createSidebarGuard({ fs, path, AsyncLocalStorage, environment, forbidden });
  const session = { header: { cwd: workspace } };
  const ctx = { sessions: { get: id => id === 'alice-session' ? session : undefined }, get: () => undefined };
  return { temp, privateRoot, home, workspace, other, outside, runtime, environment, guard, ctx };
}

test('workspace reads and missing destinations stay confined, including sibling-prefix paths', t => {
  const { guard, workspace, outside } = fixture(t);
  assert.equal(guard.target(workspace, 'note.txt'), path.join(workspace, 'note.txt'));
  assert.equal(guard.target(workspace, 'new/folder/file.txt'), path.join(workspace, 'new/folder/file.txt'));
  assert.throws(() => guard.target(workspace, outside));
  assert.throws(() => guard.target(workspace, '../other.txt'));
  assert.throws(() => guard.target(workspace, `${workspace}-other/file.txt`));
  assert.throws(() => guard.target('', 'note.txt'));
});

test('junctions cannot escape through existing reads or missing write destinations', t => {
  const { guard, workspace, outside } = fixture(t);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  fs.symlinkSync(outside, path.join(workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => guard.target(workspace, 'escape/secret.txt'));
  assert.throws(() => guard.target(workspace, 'escape/not-created/file.txt'));
  const inside = path.join(workspace, 'inside'); fs.mkdirSync(inside);
  fs.symlinkSync(inside, path.join(workspace, 'safe-link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(guard.target(workspace, 'safe-link/new.txt'), path.join(workspace, 'safe-link/new.txt'));
});

test('private account data and installation remain denied even under a broad selected directory', t => {
  const { guard, temp, workspace, home, other, runtime } = fixture(t);
  for (const blocked of [home, other, runtime, path.join(other, 'history.sqlite')]) assert.throws(() => guard.target(temp, blocked));
  assert.equal(guard.target(temp, path.join(workspace, 'note.txt')), path.join(workspace, 'note.txt'));
  assert.throws(() => guard.root(other));
});

test('missing company context or workspaces fails closed', t => {
  const { environment, guard, home, outside } = fixture(t);
  fs.renameSync(path.join(home, 'workspaces'), path.join(home, 'parked-workspaces'));
  assert.throws(() => guard.target(outside, 'file.txt'));
  delete environment.DSH_HOME;
  assert.throws(() => guard.root(outside));
});

test('session root comes from live/current or cold authoritative state, never caller hints', async t => {
  const { guard, ctx, workspace, outside } = fixture(t);
  assert.equal(await guard.sessionRoot(ctx, 'alice-session'), fs.realpathSync(workspace));
  await assert.rejects(() => guard.sessionRoot(ctx, 'unknown'));
  let disposed = false;
  ctx.get = name => name === 'sessionQuery' ? { observeSession: async () => ({
    header: { cwd: outside }, projections: { values: { workingDirectory: workspace } },
    [Symbol.dispose]() { disposed = true; },
  }) } : undefined;
  assert.equal(await guard.sessionRoot(ctx, 'cold'), fs.realpathSync(workspace));
  assert.equal(disposed, true);
});

test('request scope rejects Git selector escapes and internal cwd expansion; concurrent scopes stay independent', async t => {
  const { guard, ctx, workspace, outside } = fixture(t);
  let called = false;
  await assert.rejects(() => guard.invoke(ctx, 'git.status', { sessionId: 'alice-session', repoRoot: outside }, () => { called = true; }));
  assert.equal(called, false);
  await assert.rejects(() => guard.invoke(ctx, 'fs.read', { sessionId: 'alice-session', cwd: outside }, () => guard.target(outside, 'secret.txt')));
  const answer = await guard.invoke(ctx, 'fs.read', { sessionId: 'alice-session', cwd: outside }, () => guard.target(workspace, 'note.txt'));
  assert.equal(answer, path.join(workspace, 'note.txt'));
  await assert.rejects(() => guard.invoke(ctx, 'fs.read', { cwd: outside }, () => { called = true; }));
  const otherCtx = { sessions: { get: () => ({ header: { cwd: outside } }) }, get: () => undefined };
  const answers = await Promise.all([
    guard.invoke(ctx, 'fs.read', { sessionId: 'alice-session' }, async () => { await new Promise(resolve => setImmediate(resolve)); return guard.target(workspace, 'note.txt'); }),
    guard.invoke(otherCtx, 'fs.read', { sessionId: 'outside-session' }, async () => { await new Promise(resolve => setImmediate(resolve)); return guard.target(outside, 'note.txt'); }),
  ]);
  assert.deepEqual(answers, [path.join(workspace, 'note.txt'), path.join(outside, 'note.txt')]);
});

test('directory archives refuse nested links out of scope before starting a task', async t => {
  const { guard, ctx, workspace, outside } = fixture(t);
  const folder = path.join(workspace, 'folder'); fs.mkdirSync(folder);
  fs.symlinkSync(outside, path.join(folder, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  let called = false;
  await assert.rejects(() => guard.invoke(ctx, 'archive.build', { sessionId: 'alice-session', paths: [folder] }, () => { called = true; }));
  assert.equal(called, false);
});

test('Git metadata cannot redirect to another account or outside the session', async t => {
  const { guard, ctx, workspace, outside } = fixture(t);
  fs.writeFileSync(path.join(workspace, '.git'), `gitdir: ${outside}`);
  await assert.rejects(() => guard.invoke(ctx, 'git.status', { sessionId: 'alice-session' }, () => guard.git(workspace)));
  fs.unlinkSync(path.join(workspace, '.git')); fs.mkdirSync(path.join(workspace, '.git'));
  await guard.invoke(ctx, 'git.status', { sessionId: 'alice-session' }, () => guard.git(workspace));
  fs.writeFileSync(path.join(workspace, '.git', 'commondir'), outside);
  await assert.rejects(() => guard.invoke(ctx, 'git.status', { sessionId: 'alice-session' }, () => guard.git(workspace)));
});

test('scoped reveal and built-in local editor URLs work, opaque and unscoped opens are denied', async t => {
  const { guard, ctx, workspace, outside } = fixture(t);
  const file = path.join(workspace, 'note.txt');
  const handler = () => 'opened';
  assert.equal(await guard.invoke(ctx, 'open.external', { sessionId: 'alice-session', action: 'reveal', path: file }, handler), 'opened');
  const url = `vscode://file/${file.replaceAll('\\', '/').replace(/^\//, '')}`;
  assert.equal(await guard.invoke(ctx, 'open.external', { sessionId: 'alice-session', action: 'url', url }, handler), 'opened');
  await assert.rejects(() => guard.invoke(ctx, 'open.external', { action: 'reveal', path: file }, handler));
  await assert.rejects(() => guard.invoke(ctx, 'open.external', { sessionId: 'alice-session', action: 'reveal', path: outside }, handler));
  await assert.rejects(() => guard.invoke(ctx, 'open.external', { sessionId: 'alice-session', action: 'url', url: 'custom://command?run=anything' }, handler));
});

test('sidechat requires the existing company persistence and a real cloud write lease', async t => {
  const { guard } = fixture(t);
  await assert.rejects(() => guard.admit({ get: () => ({}) }, 'child'));
  for (const result of [{ local: true, leaseId: null }, { local: false, leaseId: null }])
    await assert.rejects(() => guard.admit({ get: () => ({ rufaExactHistory: true, ensureWrite: async () => result }) }, 'child'));
  const calls = [];
  await guard.admit({ get: name => { assert.equal(name, 'sessionPersistence'); return { rufaExactHistory: true, ensureWrite: async (...args) => { calls.push(args); return { local: false, leaseId: 'lease' }; } }; } }, 'child');
  assert.deepEqual(calls, [['child', { submission: true }]]);
});

test('unrecognized artifacts are refused before any edit', () => {
  assert.throws(() => patchSidebarSource('arbitrary source'), /Unrecognized/);
  assert.throws(() => patchSidebarClientSource('arbitrary source'), /Unrecognized/);
});

const publishedRoot = process.env.RUFA_SIDEBAR_SOURCE;
test('exact npm artifact patches idempotently; emitted host syntax and sidechat admission are valid', { skip: !publishedRoot }, async t => {
  const f = fixture(t);
  const source = fs.readFileSync(path.join(publishedRoot, 'lib/index.js'), 'utf8');
  const patched = patchSidebarSource(source);
  assert.equal(patchSidebarSource(patched), patched);
  assert.throws(() => patchSidebarSource(patched.replace('return rufaSidebarGuard.target(cwd,', 'return requireAbsolute(cwd,')), /differs/);
  const file = path.join(f.temp, 'patched.mjs'); fs.writeFileSync(file, patched);
  const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true });
  assert.equal(checked.status, 0, checked.stderr);
  const extract = name => { const start = patched.indexOf(`async function ${name}(`); return patched.slice(start, patched.indexOf('\n}', start) + 2); };
  let allowed = false;
  const history = [];
  const agent = { id: 'child', ctx: {}, inject: () => history.push('inject'), followup: () => history.push('followup') };
  const functions = runInNewContext(`${extract('admitFollowup')}\n${extract('admitFirstContact')}\n({admitFollowup,admitFirstContact})`, {
    rufaSidebarGuard: { admit: async () => { history.push('authorize'); if (!allowed) throw new Error('revoked'); } },
    createUserMessage: value => value, textPrompt: text => [{ type: 'text', text }], SIDE_INJECTION_SOURCE_KIND: 'plugin:dsh-better-sidebar',
  });
  await assert.rejects(() => functions.admitFirstContact(agent, 'context', 'question'), /revoked/);
  assert.deepEqual(history, ['authorize']);
  history.length = 0; allowed = true;
  await functions.admitFirstContact(agent, 'context', 'question');
  assert.deepEqual(history, ['authorize', 'inject', 'followup']);
  for (const name of ['client.js', 'client-registry.js']) {
    const client = fs.readFileSync(path.join(publishedRoot, 'lib', name), 'utf8');
    assert.equal(patchSidebarClientSource(patchSidebarClientSource(client)), patchSidebarClientSource(client));
  }
  const target = path.join(f.runtime, 'node_modules/dsh-better-sidebar'); fs.mkdirSync(path.join(target, 'lib'), { recursive: true });
  fs.copyFileSync(path.join(publishedRoot, 'package.json'), path.join(target, 'package.json'));
  for (const name of ['index.js', 'client.js', 'client-registry.js']) fs.copyFileSync(path.join(publishedRoot, 'lib', name), path.join(target, 'lib', name));
  assert.equal((await applySidebarCompatibility(f.runtime)).changed, true);
  assert.equal((await applySidebarCompatibility(f.runtime)).changed, false);
});
