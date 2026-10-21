import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, readdir, realpath, symlink } from 'node:fs/promises';
import { join, basename, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import { migrateCompanyProjects } from '../src/runtime/company-project-migration.mjs';
import { SessionCache } from '../src/runtime/session-cache.mjs';

const serverUrl = 'https://synthetic.company', userId = 'synthetic-employee';
const scope = createHash('sha256').update(`${serverUrl}:${userId}`).digest('hex');
const key = path => process.platform === 'win32' ? normalize(path).toLowerCase() : normalize(path);
const workspaceFile = 'storages/workspace.json', foldersFile = 'company-project-folders.json';
const read = async (home, name) => JSON.parse(await readFile(join(home, name), 'utf8'));
const write = async (home, name, value) => { await mkdir(join(home, name, '..'), { recursive: true }); await writeFile(join(home, name), JSON.stringify(value)); };
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rufa-project-migration-')));
  const sourceAccountHome = join(root, 'old', 'accounts', scope), targetAccountHome = join(root, 'new', 'accounts', scope);
  await mkdir(sourceAccountHome, { recursive: true }); await mkdir(targetAccountHome, { recursive: true });
  const paths = [join(root, 'business', '04d63fdc-4123-4935-8589-8ea892aa81ab'), join(root, 'business', 'default'), join(root, 'business', 'deleted-project')];
  for (const path of paths) await mkdir(path, { recursive: true });
  const headers = paths.map((cwd, i) => ({ id: `session-${i}`, cwd, createdAt: 1000 + i, version: 4, isSeeded: false }));
  const record = (i, title = basename(paths[i])) => ({ path: paths[i], title, sessionIds: [headers[i].id], createdAt: new Date(headers[i].createdAt).toISOString(), updatedAt: new Date(headers[i].createdAt).toISOString() });
  const document = rows => ({ unit: { name: 'workspace', version: 2 }, global: { initialized: true, workspaceIds: Object.keys(rows), archivedSessionIds: [], pinnedSessionIds: [] }, tables: { workspaces: rows } });
  const source = document({ 'old-a': record(0, '其他内容'), 'old-default': record(1, 'Rufajx默认工作区') });
  source.global.archivedSessionIds = ['session-2'];
  const target = document({ 'new-a': record(0), 'new-default': record(1), 'new-deleted': record(2) });
  await write(sourceAccountHome, workspaceFile, source); await write(targetAccountHome, workspaceFile, target);
  await write(sourceAccountHome, foldersFile, { version: 1, projects: {
    [key(paths[0])]: { workspaceId: 'old-a', path: paths[0], referencePaths: [paths[1]] },
    [key(paths[2])]: { workspaceId: 'old-deleted', path: paths[2], referencePaths: [] },
  } });
  for (const home of [sourceAccountHome, targetAccountHome]) {
    const cache = new SessionCache(home);
    for (const header of headers) { cache.ensure(header); cache.append(header.id, [{ seq: 0, type: 'session/meta', data: { text: 'immutable' } }]); }
    cache.close();
    await writeFile(join(home, 'draft-sentinel'), 'keep draft'); await writeFile(join(home, 'credential-sentinel'), 'never import');
  }
  return { root, source, target, paths, sourceAccountHome, targetAccountHome, options: { sourceAccountHome, targetAccountHome, serverUrl, userId } };
}

test('same-account project migration restores titles, references and archives without reviving deleted projects', async t => {
  const f = await fixture(), before = await readFile(join(f.targetAccountHome, workspaceFile));
  const dbBefore = await readFile(join(f.targetAccountHome, 'company-history.sqlite'));
  const plan = await migrateCompanyProjects({ ...f.options, dryRun: true });
  assert.equal(plan.status, 'planned'); assert.equal(plan.archiveStateImported, true);
  assert.deepEqual(await readFile(join(f.targetAccountHome, workspaceFile)), before);
  assert.ok(plan.changes.some(row => row.kind === 'drop-bootstrap-projection'));
  await migrateCompanyProjects({ ...f.options, dryRun: false });
  const current = await read(f.targetAccountHome, workspaceFile), folders = await read(f.targetAccountHome, foldersFile);
  assert.deepEqual(current.global.workspaceIds, ['new-a', 'new-default']);
  assert.equal(current.tables.workspaces['new-a'].title, '其他内容');
  assert.equal(current.tables.workspaces['new-default'].title, 'Rufajx默认工作区');
  assert.deepEqual(current.global.archivedSessionIds, ['session-2']);
  assert.equal(folders.projects[key(f.paths[0])].workspaceId, 'new-a');
  assert.deepEqual(folders.projects[key(f.paths[0])].referencePaths, [f.paths[1]]);
  assert.equal(folders.projects[key(f.paths[2])], undefined);
  assert.deepEqual(await readFile(join(f.targetAccountHome, 'company-history.sqlite')), dbBefore);
  assert.equal(await readFile(join(f.targetAccountHome, 'draft-sentinel'), 'utf8'), 'keep draft');
  assert.equal(await readFile(join(f.targetAccountHome, 'credential-sentinel'), 'utf8'), 'never import');
  const backupId = (await readdir(join(f.targetAccountHome, '.rufa-project-migration')))[0];
  assert.deepEqual(await readFile(join(f.targetAccountHome, '.rufa-project-migration', backupId, 'target', workspaceFile)), before);
  current.tables.workspaces['new-a'].title = '用户后来修改'; await write(f.targetAccountHome, workspaceFile, current);
  assert.equal((await migrateCompanyProjects({ ...f.options, dryRun: false })).status, 'complete');
  assert.equal((await read(f.targetAccountHome, workspaceFile)).tables.workspaces['new-a'].title, '用户后来修改');
  t.diagnostic(`Synthetic profile evidence: ${f.root}`);
});

test('explicit target titles, references, archive choices and later project activity survive', async () => {
  const f = await fixture(); f.target.tables.workspaces['new-a'].title = '安装后自己命名';
  f.target.tables.workspaces['new-deleted'].updatedAt = new Date(9000).toISOString();
  f.target.global.pinnedSessionIds = ['session-2'];
  await write(f.targetAccountHome, workspaceFile, f.target);
  await write(f.targetAccountHome, foldersFile, { version: 1, projects: { [key(f.paths[0])]: { workspaceId: 'new-a', path: f.paths[0], referencePaths: [] } } });
  await migrateCompanyProjects({ ...f.options, dryRun: false });
  const current = await read(f.targetAccountHome, workspaceFile);
  assert.equal(current.tables.workspaces['new-a'].title, '安装后自己命名'); assert.ok(current.tables.workspaces['new-deleted']);
  assert.deepEqual(current.global.archivedSessionIds, []); assert.deepEqual(current.global.pinnedSessionIds, ['session-2']);
  assert.deepEqual((await read(f.targetAccountHome, foldersFile)).projects[key(f.paths[0])].referencePaths, []);
});

test('interrupted migration replays exact prepared files without overwriting a later edit', async () => {
  const f = await fixture();
  await assert.rejects(migrateCompanyProjects({ ...f.options, dryRun: false, checkpoint: stage => { if (stage === workspaceFile) throw new Error('controlled stop'); } }), /controlled stop/);
  assert.equal((await migrateCompanyProjects({ ...f.options, dryRun: false })).status, 'complete');
  assert.equal((await read(f.targetAccountHome, workspaceFile)).tables.workspaces['new-a'].title, '其他内容');
  const conflict = await fixture();
  await assert.rejects(migrateCompanyProjects({ ...conflict.options, dryRun: false, checkpoint: stage => { if (stage === 'prepared') throw new Error('controlled stop'); } }), /controlled stop/);
  conflict.target.tables.workspaces['new-a'].title = '新修改'; await write(conflict.targetAccountHome, workspaceFile, conflict.target);
  await assert.rejects(migrateCompanyProjects({ ...conflict.options, dryRun: false }), /新修改/);
  assert.equal((await read(conflict.targetAccountHome, workspaceFile)).tables.workspaces['new-a'].title, '新修改');
});

test('foreign account, damaged registry and redirected backup paths are rejected before target writes', async () => {
  const f = await fixture(), before = await readFile(join(f.targetAccountHome, workspaceFile));
  await assert.rejects(migrateCompanyProjects({ ...f.options, userId: 'different-account', dryRun: false }), /同一/);
  const outside = join(f.root, 'outside'); await mkdir(outside);
  await symlink(outside, join(f.targetAccountHome, '.rufa-project-migration'), 'junction');
  await assert.rejects(migrateCompanyProjects({ ...f.options, dryRun: false }), /重定向/);
  assert.deepEqual(await readdir(outside), []); assert.deepEqual(await readFile(join(f.targetAccountHome, workspaceFile)), before);
  const damaged = await fixture(); damaged.source.global.workspaceIds.push('missing'); await write(damaged.sourceAccountHome, workspaceFile, damaged.source);
  await assert.rejects(migrateCompanyProjects({ ...damaged.options, dryRun: false }), /不一致/);
});
