import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm, symlink, link, readdir } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { createVersionScopes } from '../src/runtime/file-version-tracking.mjs';
import { createVersionService } from '../src/runtime/file-versions.mjs';
import { createFileVersionStore } from '../src/runtime/file-version-store.mjs';
import { importUpstream } from '../src/runtime/import-upstream.mjs';
import { badgeProcessEnvironment, runBadgeHelper } from '../src/runtime/company-badge-process.mjs';
import { parseCompanyBadgeArguments } from '../src/runtime/company-badge-paths.mjs';
import { patchBadgeProvider } from '../../../scripts/badge-runtime.mjs';

const runtime = process.env.RUFA_RUNTIME_ROOT;
const helperPath = fileURLToPath(new URL('../../../scripts/assets/company-badge/badge_metadata.py', import.meta.url));
const pythonPath = runtime && join(runtime, 'company-python/python.exe');
const signal = () => new AbortController().signal;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const settle = () => new Promise(done => setImmediate(done));
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rufa-badge-tool-')));
  const privateRoot = join(root, 'company'), accountHome = join(privateRoot, 'accounts', 'a'.repeat(64)), runtimeRoot = join(root, 'runtime');
  const cwd = join(accountHome, 'workspaces', 'sessions', randomUUID());
  await mkdir(cwd, { recursive: true }); await mkdir(runtimeRoot);
  const cleanup = [];
  t.after(async () => {
    for (const close of cleanup.reverse()) await close();
    assert.equal(dirname(root), await realpath(tmpdir())); assert.ok(basename(root).startsWith('rufa-badge-tool-'));
    await rm(root, { recursive: true, force: true });
  });
  return { root, privateRoot, accountHome, runtimeRoot, cwd, path: join(cwd, '公司成果.md'), cleanup };
}
async function patchedProvider(f) {
  const directory = join(f.root, 'provider'); await mkdir(join(directory, 'lib'), { recursive: true }); await mkdir(join(directory, 'assets'));
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
  await symlink(join(runtime, 'node_modules'), join(directory, 'node_modules'), 'junction');
  await writeFile(join(directory, 'assets/dsh-badge.md'), 'company badge');
  const source = await readFile(join(runtime, 'node_modules/@deepseek-ai/dsh-skill-badge/lib/index.js'), 'utf8');
  await writeFile(join(directory, 'lib/index.js'), patchBadgeProvider(source));
  return import(pathToFileURL(join(directory, 'lib/index.js')).href);
}
async function nativeFixture(t, makeHelper = async () => helperPath) {
  const f = await fixture(t);
  const [{ Context }, { default: SystemPrompt }, { default: ToolRuntime }, { default: Sessions }, { default: Skills }, badge] = await Promise.all([
    importUpstream('@deepseek-ai/cordis'), importUpstream('@deepseek-ai/dsh-system-prompt'), importUpstream('@deepseek-ai/dsh-tools'),
    importUpstream('@deepseek-ai/dsh-session'), importUpstream('@deepseek-ai/dsh-skill'), import('../src/runtime/company-badge.mjs'),
  ]);
  const ctx = new Context(); await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime); await ctx.plugin(Sessions); await ctx.plugin(Skills);
  const session = ctx.sessions.create('badge-session', { meta: { cwd: f.cwd } });
  const agent = { id: session.id, session, status: 'idle', ctx };
  ctx.provide('agents', { list: () => [agent], get: id => id === agent.id ? agent : undefined });
  ctx.provide('workingDirectory', { get: () => f.cwd });
  const scopes = await createVersionScopes(f);
  const store = await createFileVersionStore({ directory: join(f.accountHome, 'file-versions'), allowedRoots: id => scopes.roots(id), privateRoots: [f.runtimeRoot] });
  const versions = await createVersionService({ ...f, scopes, store, ctx, pythonPath, authorize: async () => {} });
  ctx.provide('rufaFileVersions', versions);
  ctx.on('tools/execute', (execution, next) => versions.execute(execution, next), { prepend: true, global: true });
  const oldEnv = Object.fromEntries(['RUFA_BRIDGE_ORIGIN', 'RUFA_BRIDGE_TOKEN', 'RUFA_DEVICE_ID'].map(key => [key, process.env[key]]));
  let username = '李工', accountReads = 0, accountHook;
  const server = createServer(async (req, res) => {
    assert.equal(req.url, '/company/account'); assert.equal(req.headers['x-rufa-bridge'], 'synthetic-bridge');
    const number = ++accountReads;
    const status = await accountHook?.(number) ?? 200;
    if (res.destroyed) return;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(status === 200 ? { user: { id: 'verified-user', username, role: 'employee' } } : { error: { code: 'LOGIN_REQUIRED' } }));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  process.env.RUFA_BRIDGE_ORIGIN = `http://127.0.0.1:${server.address().port}`; process.env.RUFA_BRIDGE_TOKEN = 'synthetic-bridge'; process.env.RUFA_DEVICE_ID = 'synthetic-device';
  const provider = await patchedProvider(f);
  await ctx.plugin(badge, { pythonPath, helperPath: await makeHelper(f) });
  let providerFiber = await ctx.plugin(provider); await settle();
  f.cleanup.push(async () => {
    await ctx.fiber.dispose(); await versions.close(); server.closeAllConnections(); await new Promise(done => server.close(done));
    for (const [key, value] of Object.entries(oldEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });
  return { ...f, ctx, agent, scopes, store, versions, provider,
    reads: () => accountReads, setUser: value => { username = value; }, onAccount: hook => { accountHook = hook; },
    disable: async () => { await providerFiber.dispose(); await settle(); },
    enable: async () => { providerFiber = await ctx.plugin(provider); await settle(); },
    run: (args, abort = signal()) => ctx.tools.execute({ agent, name: 'company_badge', arguments: args, callId: randomUUID(), signal: abort }),
  };
}

test('metadata arguments reject model-provided identity and helper environment excludes bridge secrets', () => {
  for (const args of [{ operation: 'stamp', path: 'file.md', username: 'forged' }, { operation: 'read', path: 'file.md', sources: ['a.md'] },
    { operation: 'stamp', path: 'file.md', sources: Array(17).fill('a.md') }]) assert.throws(() => parseCompanyBadgeArguments(args));
  assert.deepEqual(badgeProcessEnvironment({ PATH: 'tools', SystemRoot: 'Windows', RUFA_BRIDGE_TOKEN: 'secret', PYTHONPATH: 'injection', NODE_OPTIONS: 'hook' }), { PATH: 'tools', SystemRoot: 'Windows' });
});

test('native tool stamps verified Chinese usernames, merges sources and captures exact file versions', { skip: !runtime }, async t => {
  const f = await nativeFixture(t); await writeFile(f.path, '# 公司成果\n正文保持原样。\n');
  const before = await readFile(f.path);
  let result = await f.run({ operation: 'read', path: f.path }); assert.equal(result.isError, false, JSON.stringify(result));
  assert.deepEqual(JSON.parse(result.content[0].text), { authors: [], format: 'md' });
  assert.deepEqual(await f.scopes.roots(f.agent.id), []); // read must not mint history capabilities
  result = await f.run({ operation: 'stamp', path: f.path }); assert.equal(result.isError, false, JSON.stringify(result));
  assert.deepEqual(JSON.parse(result.content[0].text).authors, ['李工']); assert.equal(f.reads(), 3);
  const after = await readFile(f.path), scope = { sessionId: f.agent.id };
  let rows = await f.store.list(f.path, scope); assert.deepEqual(rows.map(row => row.phase), ['after', 'before']);
  assert.deepEqual(await readFile((await f.store.getVersion(rows.at(-1).id, scope)).blobPath), before);
  assert.deepEqual(await readFile((await f.store.getVersion(rows[0].id, scope)).blobPath), after);
  f.setUser('王工');
  const output = join(f.cwd, '后续成果.md'); await writeFile(output, '# 后续成果\n');
  result = await f.run({ operation: 'stamp', path: output, sources: [f.path] }); assert.equal(result.isError, false, JSON.stringify(result));
  assert.deepEqual(JSON.parse(result.content[0].text).authors, ['李工', '王工']);
  result = await f.run({ operation: 'stamp', path: output, sources: [f.path] });
  assert.equal(JSON.parse(result.content[0].text).changed, false);
  result = await f.run({ operation: 'stamp', path: f.path }); assert.deepEqual(JSON.parse(result.content[0].text).authors, ['李工', '王工']);
});

test('native approval denial, forged username, private/link paths and foreign agent reject before history capture', { skip: !runtime }, async t => {
  const f = await nativeFixture(t); await writeFile(f.path, 'original');
  const off = f.ctx.on('tools/pre-execute', async () => ({ kind: 'deny', reason: 'controlled review denial' }));
  assert.equal((await f.run({ operation: 'stamp', path: f.path })).isError, true); off();
  assert.equal((await f.run({ operation: 'stamp', path: f.path, username: 'forged' })).isError, true);
  const privatePath = join(f.accountHome, 'private.md'); await writeFile(privatePath, 'private');
  const hardlinked = join(f.cwd, 'hardlinked.md'); await link(f.path, hardlinked);
  const alias = join(f.root, 'alias'); await symlink(f.cwd, alias, 'junction');
  for (const path of [privatePath, hardlinked, join(alias, '公司成果.md'), join(f.cwd, 'missing.md'), `${f.path}:ads`]) {
    assert.equal((await f.run({ operation: 'stamp', path })).isError, true, path);
  }
  const clean = join(f.cwd, 'clean.md'); await writeFile(clean, 'clean');
  assert.equal((await f.run({ operation: 'stamp', path: clean, sources: [privatePath] })).isError, true);
  assert.deepEqual(await f.scopes.roots(f.agent.id), []); assert.equal(f.reads(), 0);
  await assert.rejects(f.versions.validateToolPath({ agent: { id: f.agent.id }, signal: signal() }, f.path), /当前本机/);
  assert.equal(await readFile(f.path, 'utf8'), 'original');
});

test('server revocation or identity change at publish prevents changes and retains an unchanged history', { skip: !runtime }, async t => {
  const f = await nativeFixture(t); await writeFile(f.path, 'original');
  f.onAccount(number => number === 2 ? 401 : 200);
  assert.equal((await f.run({ operation: 'stamp', path: f.path })).isError, true);
  assert.equal(await readFile(f.path, 'utf8'), 'original');
  f.onAccount(number => { if (number === 4) f.setUser('different-account'); });
  assert.equal((await f.run({ operation: 'stamp', path: f.path })).isError, true);
  assert.equal(await readFile(f.path, 'utf8'), 'original');
  const rows = await f.store.list(f.path, { sessionId: f.agent.id }); assert.equal(new Set(rows.map(row => row.hash)).size, 1);
  assert.equal((await readdir(f.cwd)).some(name => name.startsWith('.rufa-badge-')), false);
});

test('disabling the real patched badge provider aborts pending publication and re-enabling registers one tool', { skip: !runtime, timeout: 15000 }, async t => {
  const f = await nativeFixture(t); await writeFile(f.path, 'original');
  const ready = deferred(), resume = deferred();
  f.onAccount(async number => { if (number === 2) { ready.resolve(); await resume.promise; } });
  const pending = f.run({ operation: 'stamp', path: f.path }); await ready.promise;
  await f.disable(); resume.resolve();
  assert.equal((await pending).isError, true); assert.equal(await readFile(f.path, 'utf8'), 'original');
  assert.equal((await f.run({ operation: 'read', path: f.path })).isError, true);
  await f.enable(); assert.equal((await f.run({ operation: 'read', path: f.path })).isError, false);
  await f.disable(); await f.enable(); assert.equal((await f.run({ operation: 'stamp', path: f.path })).isError, false);
});

test('native badge skill registers in an isolated skills registry without requiring tool services', { skip: !runtime }, async t => {
  const f = await fixture(t), [{ Context }, { default: Skills }] = await Promise.all([importUpstream('@deepseek-ai/cordis'), importUpstream('@deepseek-ai/dsh-skill')]);
  const ctx = new Context(); await ctx.plugin(Skills); t.after(() => ctx.fiber.dispose());
  const provider = await patchedProvider(f); assert.deepEqual(provider.inject, ['skills']);
  const fiber = await ctx.plugin(provider); await settle(); assert.ok(fiber);
  assert.equal(ctx.get('tools'), undefined); assert.equal(ctx.get('rufaCompanyBadgeTools'), undefined);
  const skill = await ctx.skills.get('dsh-badge'); assert.equal(skill.name, 'dsh-badge');
});

test('workbench shutdown cancels a waiting badge and keeps the version lock until subprocess closure', { skip: !runtime, timeout: 15000 }, async t => {
  const f = await nativeFixture(t); await writeFile(f.path, 'original');
  const ready = deferred(), resume = deferred();
  f.onAccount(async number => { if (number === 2) { ready.resolve(); await resume.promise; } });
  const pending = f.run({ operation: 'stamp', path: f.path }); await ready.promise;
  let dispatched = false;
  const waiting = f.versions.execute({ agent: f.agent, name: 'write', arguments: { file_path: f.path }, signal: signal() }, async () => {
    dispatched = true; assert.equal((await readdir(f.cwd)).some(name => name.startsWith('.rufa-badge-')), false);
    assert.equal(await readFile(f.path, 'utf8'), 'original'); return 'next mutation';
  });
  await settle(); assert.equal(dispatched, false);
  process.emit('message', { type: 'rufa:shutdown' }); resume.resolve();
  assert.equal((await pending).isError, true); assert.equal(await waiting, 'next mutation');
  assert.equal((await f.run({ operation: 'read', path: f.path })).isError, true);
});

test('concurrent target or source edits are retained and prevent helper publication', { skip: !runtime }, async t => {
  const f = await fixture(t), source = join(f.cwd, 'source.md');
  for (const changed of [f.path, source]) {
    await writeFile(f.path, 'original'); await writeFile(source, 'source');
    await assert.rejects(runBadgeHelper({ pythonPath, helperPath, request: { operation: 'stamp', path: f.path, sources: [source], username: '李工' },
      signal: signal(), beforePublish: async () => { await writeFile(changed, 'external edit'); } }));
    assert.equal(await readFile(f.path, 'utf8'), changed === f.path ? 'external edit' : 'original');
    assert.equal((await readdir(f.cwd)).some(name => name.startsWith('.rufa-badge-')), false);
  }
});

test('disabling after permission was sent kills the actual helper before its paused OS publish', { skip: !runtime, timeout: 15000 }, async t => {
  let marker, release;
  const f = await nativeFixture(t, async paths => {
    marker = join(paths.root, 'publish-reached'); release = join(paths.root, 'publish-release');
    const shim = join(paths.root, 'pause-publish.py');
    // Use the real helper implementation and real preparation/identity checks.
    // Only the final OS publication is paused to exercise the post-permit race.
    await writeFile(shim, `import importlib.util,json,sys,time\nfrom pathlib import Path\nsys.stdin.reconfigure(encoding="utf-8")\nsys.stdout.reconfigure(encoding="utf-8")\nspec=importlib.util.spec_from_file_location("badge",${JSON.stringify(helperPath)})\nm=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(m)\noriginal=m.publish\ndef paused(target,temporary):\n    Path(${JSON.stringify(marker)}).write_text("ready")\n    while not Path(${JSON.stringify(release)}).exists(): time.sleep(0.01)\n    original(target,temporary)\nm.publish=paused\nm.emit(m.run(json.loads(sys.stdin.readline())))\n`);
    return shim;
  });
  await writeFile(f.path, 'original');
  const pending = f.run({ operation: 'stamp', path: f.path });
  for (let attempts = 0;; attempts++) {
    try { await readFile(marker); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert.ok(attempts < 400, 'real helper did not reach final publication'); await new Promise(done => setTimeout(done, 10));
  }
  await f.disable(); assert.equal((await pending).isError, true);
  await writeFile(release, 'release'); await new Promise(done => setTimeout(done, 100));
  assert.equal(await readFile(f.path, 'utf8'), 'original');
  const rows = await f.store.list(f.path, { sessionId: f.agent.id }); assert.equal(new Set(rows.map(row => row.hash)).size, 1);
});

test('helper cancellation and timeouts close the child before completion, never publish or expose stderr', { skip: !runtime }, async t => {
  const f = await fixture(t); await writeFile(f.path, 'original');
  const ready = deferred(), controller = new AbortController();
  const pending = runBadgeHelper({ pythonPath, helperPath, request: { operation: 'stamp', path: f.path, username: '王工' }, signal: controller.signal,
    beforePublish: async () => { ready.resolve(); await new Promise(() => {}); } });
  await ready.promise; controller.abort(); await assert.rejects(pending, /取消/);
  assert.equal(await readFile(f.path, 'utf8'), 'original'); assert.equal((await readdir(f.cwd)).length, 1);
  const brokenHelper = join(f.root, 'bad.py'); await writeFile(brokenHelper, 'import sys\nsys.stderr.write("TOP_SECRET_PATH_TOKEN")\nsys.exit(1)\n');
  await assert.rejects(runBadgeHelper({ pythonPath, helperPath: brokenHelper, request: { operation: 'read', path: f.path }, signal: signal() }), error => !error.message.includes('TOP_SECRET') && /未完成/.test(error.message));
  await writeFile(brokenHelper, 'import time\ntime.sleep(10)\n');
  await assert.rejects(runBadgeHelper({ pythonPath, helperPath: brokenHelper, request: { operation: 'read', path: f.path }, signal: signal(), timeoutMs: 100 }), /超时/);
});

test('helper refuses forged protocol success, oversized output and extra result properties', { skip: !runtime }, async t => {
  const f = await fixture(t), helper = join(f.root, 'protocol.py');
  for (const body of [
    'print(\'{"authors":[],"format":"md","changed":true}\')',
    'print("x" * 1200000)',
    'print(\'{"authors":[],"format":"md","secret":"unexpected"}\')',
  ]) {
    await writeFile(helper, body);
    await assert.rejects(runBadgeHelper({ pythonPath, helperPath: helper, request: { operation: body.includes('changed') ? 'stamp' : 'read', path: f.path }, signal: signal(), beforePublish: async () => {} }));
  }
});
