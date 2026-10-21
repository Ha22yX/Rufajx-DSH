import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm, symlink, rename } from 'node:fs/promises';
import { join, dirname, basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { createVersionScopes, scanVersionFiles, recordFileMutation, serialMutations } from '../src/runtime/file-version-tracking.mjs';
import { createVersionService, distinctFileVersions } from '../src/runtime/file-versions.mjs';
import { createFileVersionStore } from '../src/runtime/file-version-store.mjs';
import { importUpstream } from '../src/runtime/import-upstream.mjs';
import { createVersionActivity } from '../src/runtime/file-version-activity.mjs';

const runtime = process.env.RUFA_RUNTIME_ROOT;
const settle = () => new Promise(done => setImmediate(done));
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rufa-version-hooks-')));
  const privateRoot = join(root, 'company'), accountHome = join(privateRoot, 'accounts', 'a'.repeat(64)), runtimeRoot = join(root, 'runtime');
  const cwd = join(accountHome, 'workspaces', 'sessions', randomUUID());
  await mkdir(cwd, { recursive: true }); await mkdir(runtimeRoot);
  const scopes = await createVersionScopes({ accountHome, privateRoot, runtimeRoot });
  const store = await createFileVersionStore({ directory: join(accountHome, 'file-versions'), allowedRoots: id => scopes.roots(id), privateRoots: [runtimeRoot] });
  t.after(async () => { await store.close(); assert.equal(dirname(root), await realpath(tmpdir())); assert.ok(basename(root).startsWith('rufa-version-hooks-')); await rm(root, { recursive: true, force: true }); });
  return { root, privateRoot, accountHome, runtimeRoot, cwd, scopes, store, file: join(cwd, '计划.txt') };
}
async function nativeFixture(t) {
  const f = await fixture(t);
  const [{ Context }, { default: SystemPrompt }, { default: ToolRuntime, defineTool }, { default: Sessions }] = await Promise.all([
    importUpstream('@deepseek-ai/cordis'), importUpstream('@deepseek-ai/dsh-system-prompt'), importUpstream('@deepseek-ai/dsh-tools'), importUpstream('@deepseek-ai/dsh-session'),
  ]);
  const ctx = new Context(); await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime); await ctx.plugin(Sessions);
  const session = ctx.sessions.create('session-test', { meta: { cwd: f.cwd } });
  const agent = { id: session.id, session, status: 'idle', ctx };
  ctx.provide('agents', { list: () => [agent], get: id => id === agent.id ? agent : undefined });
  ctx.provide('workingDirectory', { get: () => f.cwd });
  ctx.provide('sessionQuery', { readEvent: async ({ sessionId, seq }) => {
    if (sessionId !== agent.id || seq !== 9) throw new Error('missing event');
    return { session: session.header, target: { type: 'deliverables/presented', data: { files: [{ path: f.file }] } } };
  } });
  let authorized = true;
  const authorize = async () => { if (!authorized) throw new Error('登录已失效。'); };
  const service = await createVersionService({ ...f, ctx, pythonPath: join(runtime, 'company-python/python.exe'), authorize });
  ctx.on('tools/execute', (execution, next) => service.execute(execution, next), { prepend: true, global: true });
  t.after(async () => { await service.close(); await ctx.fiber.dispose(); });
  const register = (name, execute, parameters = { file_path: { type: 'string', required: true }, content: { type: 'string' } }) => ctx.tools.register(defineTool({
    name, description: 'Synthetic tool body under the real native registry.', parameters,
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute,
  }));
  const run = (name, args, signal = new AbortController().signal) => ctx.tools.execute({ agent, name, arguments: args, callId: randomUUID(), signal });
  return { ...f, ctx, agent, service, register, run, revoke: () => { authorized = false; }, coordinates: { sessionId: agent.id, seq: 9, index: 0, kind: 'present' } };
}

test('native denied and cancelled calls never mint scopes, capture files or dispatch tool bodies', { skip: !runtime }, async t => {
  const f = await nativeFixture(t); await writeFile(f.file, 'unchanged');
  f.register('write', async () => assert.fail('denied body'));
  const off = f.ctx.on('tools/pre-execute', async () => ({ kind: 'deny', reason: 'synthetic native denial' }));
  assert.equal((await f.run('write', { file_path: f.file, content: 'denied' })).isError, true);
  assert.deepEqual(await f.scopes.roots(f.agent.id), []); off();
  const control = new AbortController(); control.abort();
  assert.equal((await f.run('write', { file_path: f.file, content: 'cancelled' }, control.signal)).isError, true);
  assert.deepEqual(await f.scopes.roots(f.agent.id), []); assert.equal(await readFile(f.file, 'utf8'), 'unchanged');
});

test('native dispatch captures exact raw before/after bytes and preserves the original tool result', { skip: !runtime }, async t => {
  const f = await nativeFixture(t), bytes = Buffer.from([0xef, 0xbb, 0xbf, 65, 13, 10]);
  await writeFile(f.file, bytes);
  f.register('write', async args => {
    const rows = await f.store.list(f.file, { sessionId: f.agent.id });
    assert.deepEqual(await readFile((await f.store.getVersion(rows[0].id, { sessionId: f.agent.id })).blobPath), bytes);
    await writeFile(args.file_path, args.content); return 'native-output-preserved';
  });
  const result = await f.run('write', { file_path: f.file, content: 'after\r\n' });
  assert.equal(result.isError, false); assert.deepEqual(result.content, [{ type: 'text', text: 'native-output-preserved' }]);
  const rows = await f.store.list(f.file, { sessionId: f.agent.id });
  assert.deepEqual(rows.map(row => row.phase), ['after', 'before']);
  assert.equal(await readFile((await f.store.getVersion(rows[0].id, { sessionId: f.agent.id })).blobPath, 'utf8'), 'after\r\n');
});

test('failure and cancellation after a write still retain changed bytes while native failure remains visible', { skip: !runtime }, async t => {
  const f = await nativeFixture(t); await writeFile(f.file, 'before');
  f.register('write', async args => { await writeFile(args.file_path, 'partial output'); throw new Error('script failed after writing'); });
  assert.equal((await f.run('write', { file_path: f.file })).isError, true);
  let rows = await f.store.list(f.file, { sessionId: f.agent.id }); assert.equal(rows[0].status, 'failed');
  assert.equal(await readFile((await f.store.getVersion(rows[0].id, { sessionId: f.agent.id })).blobPath, 'utf8'), 'partial output');
  const control = new AbortController();
  f.register('edit', async args => { await writeFile(args.file_path, 'cancelled output'); control.abort(); return 'written'; });
  assert.equal((await f.run('edit', { file_path: f.file }, control.signal)).isError, true);
  rows = await f.store.list(f.file, { sessionId: f.agent.id }); assert.equal(rows[0].status, 'cancelled');
  assert.equal(await readFile((await f.store.getVersion(rows[0].id, { sessionId: f.agent.id })).blobPath, 'utf8'), 'cancelled output');
});

test('a real Python Office script is captured around native tool dispatch, including new and deleted files', { skip: !runtime }, async t => {
  const f = await nativeFixture(t), python = join(runtime, 'company-python/python.exe'), spreadsheet = join(f.cwd, '排程.xlsx'), removed = join(f.cwd, '待删除.txt');
  const exec = promisify(execFile);
  await exec(python, ['-I', '-c', 'import openpyxl,sys; w=openpyxl.Workbook(); w.active["A1"]="before"; w.save(sys.argv[1])', spreadsheet], { windowsHide: true });
  const before = await readFile(spreadsheet); await writeFile(removed, 'preserve deleted bytes');
  f.register('pwsh', async () => {
    await exec(python, ['-I', '-c', 'import openpyxl,sys,pathlib; p=pathlib.Path(sys.argv[1]); w=openpyxl.load_workbook(p/"排程.xlsx"); w.active["A1"]="after"; w.save(p/"排程.xlsx"); (p/"新增.txt").write_text("new"); (p/"待删除.txt").unlink()', f.cwd], { windowsHide: true });
    return 'script finished';
  }, { command: { type: 'string', required: true } });
  assert.equal((await f.run('pwsh', { command: 'synthetic office script body' })).isError, false);
  const scope = { sessionId: f.agent.id }, rows = await f.store.list(spreadsheet, scope);
  assert.deepEqual(await readFile((await f.store.getVersion(rows.at(-1).id, scope)).blobPath), before);
  assert.notEqual(rows[0].hash, rows.at(-1).hash);
  assert.equal((await f.store.list(removed, scope))[0].hash, null);
  assert.equal((await f.store.list(join(f.cwd, '新增.txt'), scope))[0].phase, 'after');
});

test('restoration shares the full mutation lock, detects intervening writes, and consumes confirmation once', { skip: !runtime }, async t => {
  const f = await nativeFixture(t); await f.scopes.grant(f.agent.id, f.cwd, 'directory');
  await writeFile(f.file, 'original');
  const version = await f.store.capture(f.file, { sessionId: f.agent.id, operationId: 'seed', phase: 'before' });
  await writeFile(f.file, 'current');
  const ticket = await f.service.request('prepareRestore', { ...f.coordinates, versionId: version.id });
  let release, entered;
  const started = new Promise(done => { entered = done; }), gate = new Promise(done => { release = done; });
  f.register('write', async args => { entered(); await gate; await writeFile(args.file_path, 'concurrent write'); return 'done'; });
  const mutation = f.run('write', { file_path: f.file }); await started;
  let settled = false;
  const restoration = f.service.request('restore', { ticketId: ticket.ticketId }).finally(() => { settled = true; });
  await new Promise(done => setTimeout(done, 25)); assert.equal(settled, false);
  release(); await mutation;
  await assert.rejects(restoration, /变化/); assert.equal(await readFile(f.file, 'utf8'), 'concurrent write');
  await assert.rejects(f.service.request('restore', { ticketId: ticket.ticketId }), /过期/);
  const fresh = await f.service.request('prepareRestore', { ...f.coordinates, versionId: version.id });
  await f.service.request('restore', { ticketId: fresh.ticketId }); assert.equal(await readFile(f.file, 'utf8'), 'original');
  const history = await f.service.request('history', f.coordinates); assert.ok(history.versions.some(row => row.label === '恢复前保留'));
  assert.ok(!JSON.stringify(history).includes('operationId')); assert.ok(!JSON.stringify(history).includes('"hash"'));
});

test('scope grants survive restart without widening an exact external file or authorizing private or link paths', async t => {
  const f = await fixture(t), external = join(f.root, 'external'); await mkdir(external);
  const target = join(external, 'one.txt'); await writeFile(target, 'one'); await writeFile(join(external, 'two.txt'), 'two');
  await f.scopes.grant('session-test', target, 'file');
  const restarted = await createVersionScopes(f);
  assert.deepEqual(await restarted.roots('session-test'), [{ path: target, kind: 'file' }]);
  await assert.rejects(f.store.capture(join(external, 'two.txt'), { sessionId: 'session-test', operationId: 'o', phase: 'before' }));
  await assert.rejects(f.scopes.grant('session-test', join(f.accountHome, 'credentials'), 'file'));
  const alias = join(f.root, 'alias'); await symlink(external, alias, 'junction');
  await assert.rejects(f.scopes.grant('session-test', alias, 'directory'), /链接/);
  assert.deepEqual(await restarted.roots('different-session'), []);
});

test('bounded scans surface excluded folders and stop before dispatch on incomplete protection', async t => {
  const f = await fixture(t); await writeFile(f.file, 'before'); await mkdir(join(f.cwd, 'node_modules')); await writeFile(join(f.cwd, 'node_modules', 'ignored'), 'dependency');
  const scan = await scanVersionFiles(f.cwd); assert.deepEqual(scan.files, [f.file]); assert.equal(scan.excluded.length, 1);
  const execution = { name: 'pwsh', arguments: { command: 'test' }, agent: { id: 'session-test' }, signal: new AbortController().signal };
  await assert.rejects(recordFileMutation({ ...f, execution, authorize: async () => {}, next: async () => assert.fail('must not dispatch'), report: async () => {},
    scan: root => scanVersionFiles(root, { maxBytes: 1 }) }), /过大/);
  assert.equal(await readFile(f.file, 'utf8'), 'before');
});

test('continuous identical content is collapsed without hiding restore backups', () => {
  const rows = [{ id: 1, hash: 'a', phase: 'after' }, { id: 2, hash: 'a', phase: 'before' }, { id: 3, hash: 'a', phase: 'before-restore' },
    { id: 4, hash: 'b', phase: 'restored' }, { id: 5, hash: 'b', phase: 'before' }, { id: 6, hash: 'c', phase: 'before' }];
  assert.deepEqual(distinctFileVersions(rows).map(row => row.id), [1, 3, 4, 6]);
});

test('native shell workdir protects the explicit directory before dispatch and retains incomplete background status', { skip: !runtime }, async t => {
  const f = await nativeFixture(t), external = join(f.root, 'another-folder'); await mkdir(external);
  const path = join(external, 'report.txt'); await writeFile(path, 'external-before');
  f.register('pwsh', async () => {
    const rows = await f.store.list(path, { sessionId: f.agent.id });
    assert.equal(await readFile((await f.store.getVersion(rows[0].id, { sessionId: f.agent.id })).blobPath, 'utf8'), 'external-before');
    await writeFile(path, 'external-after'); return 'background acknowledgement';
  }, { command: { type: 'string', required: true }, workdir: { type: 'string' }, run_in_background: { type: 'boolean' } });
  assert.equal((await f.run('pwsh', { command: 'controlled body', workdir: external, run_in_background: true })).isError, false);
  const rows = await f.store.list(path, { sessionId: f.agent.id }); assert.equal(rows[0].status, 'incomplete');
  const restarted = await createVersionScopes(f); assert.match(await restarted.notice(f.agent.id), /阶段版本/);
  assert.deepEqual(await f.scopes.roots(f.agent.id), [external]);
});

test('replacing an authorized directory does not inherit its saved version scope', async t => {
  const f = await fixture(t), project = join(f.root, 'project'); await mkdir(project);
  await f.scopes.grant('session-test', project, 'directory'); await rename(project, join(f.root, 'old-project')); await mkdir(project);
  const restarted = await createVersionScopes(f);
  await assert.rejects(restarted.roots('session-test'), /替换/);
  await restarted.grant('session-test', project, 'directory'); assert.deepEqual(await restarted.roots('session-test'), [project]);
});

test('historical cards without a live grant return no versions without reading their file', { skip: !runtime }, async t => {
  const f = await nativeFixture(t);
  const history = await f.service.request('history', f.coordinates);
  assert.deepEqual(history.versions, []); assert.equal(history.undoVersionId, null);
  assert.deepEqual(await f.scopes.roots(f.agent.id), []);
});

test('foreign and unknown terminal ids fail before any scope grant or file capture', { skip: !runtime }, async t => {
  const f = await nativeFixture(t), foreign = { id: 'other-session' };
  const terminals = { async spawn() { return { sessionId: 'foreign-terminal' }; }, startSend() {}, read() {}, async kill() {} };
  const off = f.service.watchTerminals(terminals); t.after(off); await terminals.spawn(foreign, { cwd: f.cwd });
  f.register('terminal_send', async () => assert.fail('foreign terminal must not dispatch'), { sessionId: { type: 'string', required: true } });
  for (const sessionId of ['foreign-terminal', 'unknown-terminal']) assert.equal((await f.run('terminal_send', { sessionId })).isError, true);
  assert.deepEqual(await f.scopes.roots(f.agent.id), []);
});

test('restoration rechecks parent authorization at publication and propagates cancellation into the store', { skip: !runtime }, async t => {
  const f = await nativeFixture(t); await f.scopes.grant(f.agent.id, f.cwd, 'directory'); await writeFile(f.file, 'old');
  const version = await f.store.capture(f.file, { sessionId: f.agent.id, operationId: 'seed', phase: 'before' }); await writeFile(f.file, 'current');
  const ticket = await f.service.request('prepareRestore', { ...f.coordinates, versionId: version.id });
  let checks = 0;
  await assert.rejects(f.service.request('restore', ticket, { confirm: async () => { if (++checks === 2) throw new Error('当前窗口已关闭。'); } }), /窗口/);
  assert.equal(checks, 2); assert.equal(await readFile(f.file, 'utf8'), 'current');
  const next = await f.service.request('prepareRestore', { ...f.coordinates, versionId: version.id });
  const controller = new AbortController(); checks = 0;
  await assert.rejects(f.service.request('restore', next, { signal: controller.signal, confirm: async () => {
    if (++checks === 2) { controller.abort(new Error('已取消')); await new Promise(() => {}); }
  } }), /取消/);
  assert.equal(await readFile(f.file, 'utf8'), 'current');
});
