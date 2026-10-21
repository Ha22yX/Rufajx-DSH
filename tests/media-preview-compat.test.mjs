import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, request } from 'node:http';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { applyMediaPreviewCompatibility } from '../scripts/media-preview-compat.mjs';

// Point at the directory containing the pristine npm node_modules. Tests load
// and exercise the transformed public apply() exports, not a parallel stub route.
const source = process.env.RUFA_MEDIA_SOURCE;
const options = { skip: !source && 'Set RUFA_MEDIA_SOURCE to the pristine media-preview directory' };
const packages = ['dsh-video-preview', '@huanlin/dsh-plugin-better-sidebar-plugin-audio'];
const bytes = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(tmpdir(), 'rufa-media-routes-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(tmpdir()));
    assert.ok(path.basename(temp).startsWith('rufa-media-routes-'));
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const runtime = path.join(temp, 'runtime');
  for (const name of packages) fs.cpSync(path.join(source, 'node_modules', name), path.join(runtime, 'node_modules', name), { recursive: true });
  fs.mkdirSync(path.join(runtime, 'company-tools/media-player/wasm/decode'), { recursive: true });
  fs.writeFileSync(path.join(runtime, 'company-tools/media-player/avplayer.js'), '/* synthetic player asset */');
  fs.writeFileSync(path.join(runtime, 'company-tools/media-player/wasm/decode/mpeg4-simd.wasm'), Buffer.from([0, 97, 115, 109]));
  const privateRoot = path.join(temp, 'private'), home = path.join(privateRoot, 'accounts/alice');
  const workspace = path.join(home, 'workspaces/current'), stale = path.join(home, 'workspaces/stale');
  const other = path.join(privateRoot, 'accounts/bob'), outside = path.join(temp, 'outside');
  for (const dir of [workspace, stale, other, outside]) fs.mkdirSync(dir, { recursive: true });
  for (const dir of [workspace, stale, other, outside, runtime]) for (const ext of ['mp4', 'mp3']) fs.writeFileSync(path.join(dir, `clip.${ext}`), bytes);
  fs.writeFileSync(path.join(workspace, 'secret.txt'), 'not media');
  const previous = { DSH_HOME: process.env.DSH_HOME, RUFA_RUNTIME_ROOT: process.env.RUFA_RUNTIME_ROOT };
  Object.assign(process.env, { DSH_HOME: home, RUFA_RUNTIME_ROOT: runtime });
  t.after(() => { for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  return { temp, runtime, privateRoot, home, workspace, stale, other, outside };
}

async function harness(t) {
  const f = fixture(t);
  const first = await applyMediaPreviewCompatibility(f.runtime);
  const routes = [], disposed = [], effects = [];
  const live = { header: { cwd: f.stale } };
  const calls = { admissions: 0, observations: 0, current: 0 };
  const ctx = {
    sessions: { get: id => id === 'live' ? live : undefined },
    connection: { requestRejection(req) {
      calls.admissions++;
      if (req.headers.origin === 'https://evil.invalid') return 403;
      return req.headers.authorization === 'Bearer test-native-peer' ? undefined : 401;
    } },
    get(name) {
      if (name === 'workingDirectory') return { get: () => { calls.current++; return f.workspace; } };
      if (name === 'sessionQuery') return { observeSession: async id => {
        calls.observations++;
        if (!['cold', 'broad', 'private', 'installed'].includes(id)) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
        const cwd = id === 'broad' ? f.temp : id === 'private' ? f.other : id === 'installed' ? f.runtime : f.workspace;
        return { header: { cwd: f.stale }, projections: { values: { workingDirectory: cwd } },
          [Symbol.dispose]() { disposed.push(id); } };
      } };
    },
    webServer: { register(route) {
      assert.ok(['exact', 'prefix'].includes(route.kind));
      assert.equal(typeof route.path, 'string');
      assert.ok(route.path.startsWith('/') && !route.path.endsWith('/'));
      assert.equal(typeof route.handler, 'function');
      assert.ok(!routes.some(item => item.kind === route.kind && item.path === route.path));
      routes.push(route); return () => { routes.splice(routes.indexOf(route), 1); };
    } },
    effect(fn) { const disposer = fn(); if (typeof disposer === 'function') effects.push(disposer); },
  };
  for (const [name, entry] of [[packages[0], 'index.js'], [packages[1], 'lib/index.js']]) {
    const plugin = await import(pathToFileURL(path.join(f.runtime, 'node_modules', name, entry)).href);
    assert.ok(plugin.inject.includes('connection'));
    assert.ok(plugin.inject.includes('sessionQuery'));
    // Model Cordis admission: apply() is never entered with a missing required
    // service. In particular the obsolete webRuntime dependency stalls v1.
    for (const service of plugin.inject) assert.ok(ctx[service] ?? ctx.get(service), `missing required service: ${service}`);
    plugin.apply(ctx);
  }
  const server = createServer((req, res) => {
    // Pinned WebServer.match: query is excluded; exact wins, then the longest
    // prefix matching itself or a slash child (never a sibling name).
    const pathname = new URL(req.url, 'http://dsh.internal').pathname;
    const route = routes.find(item => item.kind === 'exact' && item.path === pathname)
      ?? routes.filter(item => item.kind === 'prefix' && (pathname === item.path || pathname.startsWith(`${item.path}/`)))
        .sort((a, b) => b.path.length - a.path.length)[0];
    if (!route) { res.writeHead(404); res.end(); return; }
    Promise.resolve(route.handler(req, res)).catch(error => { res.destroy(error); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const dispose of effects.reverse()) await dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  async function http(kind, params = {}, settings = {}) {
    const url = new URL(settings.pathname ?? (kind === 'video' ? '/video' : `/audio-preview/${kind === 'meta' ? 'meta' : 'media'}`), `http://127.0.0.1:${server.address().port}`);
    for (const [key, value] of Object.entries({ sessionId: 'live', path: kind === 'video' ? 'clip.mp4' : 'clip.mp3', ...params })) if (value !== undefined) url.searchParams.set(key, value);
    return new Promise((resolve, reject) => {
      const req = request(url, { method: settings.method ?? 'GET', headers: { authorization: 'Bearer test-native-peer', ...settings.headers } }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      });
      req.on('error', reject); req.end();
    });
  }
  return { ...f, http, first, ctx, calls, disposed };
}

test('pinned artifacts patch once, validate all inputs, preserve hard-link sources and reject drift', options, async t => {
  const f = fixture(t), host = path.join(f.runtime, 'node_modules/dsh-video-preview/index.js');
  const original = fs.readFileSync(host), shared = path.join(f.temp, 'original-host.js');
  fs.renameSync(host, shared); fs.linkSync(shared, host);
  const result = await applyMediaPreviewCompatibility(f.runtime);
  assert.equal(result.mediaPreviewCompatibility, 4);
  assert.equal(result.changed, true);
  assert.equal(result.files.filter(file => file.changed).length, 5);
  assert.deepEqual(fs.readFileSync(shared), original);
  const second = await applyMediaPreviewCompatibility(f.runtime);
  assert.equal(second.changed, false);
  assert.deepEqual(second.files.map(item => item.sha256), result.files.map(item => item.sha256));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.runtime, 'node_modules/dsh-video-preview/package.json'))).dsh.client.inject, []);
  for (const name of packages) {
    const file = path.join(f.runtime, 'node_modules', name, name === packages[0] ? 'index.js' : 'lib/index.js');
    assert.equal(spawnSync(process.execPath, ['--check', file]).status, 0);
  }
  fs.appendFileSync(host, '\n// drift\n');
  await assert.rejects(() => applyMediaPreviewCompatibility(f.runtime), /differs/);
});

test('a bad later client aborts patching before the first host is written', options, async t => {
  const f = fixture(t), host = path.join(f.runtime, 'node_modules/dsh-video-preview/index.js');
  const original = fs.readFileSync(host);
  fs.appendFileSync(path.join(f.runtime, 'node_modules', packages[1], 'lib/client.js'), '// drift');
  await assert.rejects(() => applyMediaPreviewCompatibility(f.runtime), /Unrecognized/);
  assert.deepEqual(fs.readFileSync(host), original);
});

test('real patched video and audio routes stream exact bytes and metadata from current cwd', options, async t => {
  const h = await harness(t);
  for (const kind of ['video', 'audio']) {
    const res = await h.http(kind, { cwd: h.outside });
    assert.equal(res.status, 200); assert.deepEqual(res.body, bytes);
    assert.equal(res.headers['accept-ranges'], 'bytes');
    assert.equal(res.headers['content-type'], kind === 'video' ? 'video/mp4' : 'audio/mpeg');
  }
  const meta = await h.http('meta');
  assert.equal(meta.status, 200);
  assert.equal(JSON.parse(meta.body).value.size, bytes.length);
  assert.equal(JSON.parse(meta.body).value.path, path.join(h.workspace, 'clip.mp3'));
  assert.equal(h.calls.current, 3);
});

test('required service contract activates both media hosts; prefix matching excludes query and sibling routes', options, async t => {
  const h = await harness(t);
  for (const [kind, pathname] of [['video', '/video'], ['video', '/video/'], ['video', '/video/nested'], ['audio', '/audio-preview/media'], ['meta', '/audio-preview/meta']]) {
    const res = await h.http(kind, {}, { pathname, headers: { authorization: '' } });
    assert.equal(res.status, 401, pathname);
    assert.equal(JSON.parse(res.body).ok, false);
  }
  for (const pathname of ['/videos', '/video-other', '/audio-preview-other/media']) {
    const res = await h.http('video', {}, { pathname });
    assert.equal(res.status, 404); assert.equal(res.body.length, 0);
  }
});

test('ranges support bounded, open-ended, suffix, first range and 416; malformed ranges are ignored', options, async t => {
  const h = await harness(t);
  for (const kind of ['video', 'audio']) {
    for (const [range, expected] of [['bytes=2-5', bytes.subarray(2, 6)], ['bytes=30-', bytes.subarray(30)], ['bytes=-4', bytes.subarray(-4)], ['bytes=2-5,9-11', bytes.subarray(2, 6)], ['bytes=30-999', bytes.subarray(30)]]) {
      const res = await h.http(kind, {}, { headers: { range } });
      assert.equal(res.status, 206, range); assert.deepEqual(res.body, expected);
    }
    for (const range of ['bytes=999-', 'bytes=5-2', 'bytes=-0']) {
      const res = await h.http(kind, {}, { headers: { range } });
      assert.equal(res.status, 416); assert.equal(res.headers['content-range'], `bytes */${bytes.length}`);
    }
    for (const range of ['garbage', 'bytes=-1.5', 'bytes=2e1-', 'bytes=9007199254740993-']) {
      const res = await h.http(kind, {}, { headers: { range } });
      assert.equal(res.status, 200); assert.deepEqual(res.body, bytes);
    }
  }
});

test('HEAD sends no bytes with full/range/error headers; If-Range matches dates and rejects stale or unknown tags', options, async t => {
  const h = await harness(t);
  for (const kind of ['video', 'audio']) {
    const full = await h.http(kind, {}, { method: 'HEAD' });
    assert.equal(full.status, 200); assert.equal(full.body.length, 0); assert.equal(full.headers['content-length'], String(bytes.length));
    const partial = await h.http(kind, {}, { method: 'HEAD', headers: { range: 'bytes=2-5' } });
    assert.equal(partial.status, 206); assert.equal(partial.body.length, 0); assert.equal(partial.headers['content-length'], '4');
    const allowed = await h.http(kind, {}, { headers: { range: 'bytes=2-5', 'if-range': full.headers['last-modified'] } });
    assert.equal(allowed.status, 206); assert.deepEqual(allowed.body, bytes.subarray(2, 6));
    for (const ifRange of ['Wed, 01 Jan 2020 00:00:00 GMT', 'invalid', '"unknown"', 'W/"unknown"']) {
      const res = await h.http(kind, {}, { headers: { range: 'bytes=999-', 'if-range': ifRange } });
      assert.equal(res.status, 200); assert.deepEqual(res.body, bytes);
    }
    const unauthorized = await h.http(kind, {}, { method: 'HEAD', headers: { authorization: '' } });
    assert.equal(unauthorized.status, 401); assert.equal(unauthorized.body.length, 0);
  }
  const meta = await h.http('meta', {}, { method: 'HEAD' }); assert.equal(meta.body.length, 0); assert.equal(meta.status, 200);
});

test('native request admission precedes session lookup; revoked/missing connection and cross-origin fail closed', options, async t => {
  const h = await harness(t);
  for (const kind of ['video', 'audio', 'meta']) {
    assert.equal((await h.http(kind, { sessionId: 'cold' }, { headers: { authorization: '' } })).status, 401);
    assert.equal((await h.http(kind, { sessionId: 'cold' }, { headers: { origin: 'https://evil.invalid' } })).status, 403);
  }
  assert.equal(h.calls.observations, 0); assert.equal(h.calls.current, 0);
  h.ctx.connection.requestRejection = () => 401;
  assert.equal((await h.http('video')).status, 401);
  h.ctx.connection = undefined;
  assert.equal((await h.http('audio')).status, 503);
});

test('cold sessions read authoritative projection, release observation and reject forged/missing session cwd', options, async t => {
  const h = await harness(t);
  for (const kind of ['video', 'audio']) {
    const cold = await h.http(kind, { sessionId: 'cold', cwd: h.outside });
    assert.equal(cold.status, 200); assert.deepEqual(cold.body, bytes);
    assert.equal((await h.http(kind, { sessionId: 'unknown', cwd: h.workspace })).status, 404);
    assert.equal((await h.http(kind, { sessionId: '', cwd: h.workspace })).status, 400);
  }
  assert.deepEqual(h.disposed, ['cold', 'cold']);
});

test('lexical escapes, sibling paths, current-vs-header cwd, other account and runtime are blocked', options, async t => {
  const h = await harness(t);
  for (const kind of ['video', 'audio']) {
    const ext = kind === 'video' ? 'mp4' : 'mp3';
    for (const file of [path.join(h.outside, `clip.${ext}`), path.join(h.stale, `clip.${ext}`), `../stale/clip.${ext}`, `${h.workspace}-sibling/clip.${ext}`]) {
      assert.equal((await h.http(kind, { path: file, cwd: h.outside })).status, 403, file);
    }
    for (const dir of [h.other, h.runtime]) assert.equal((await h.http(kind, { sessionId: 'broad', path: path.join(dir, `clip.${ext}`) })).status, 403);
    assert.equal((await h.http(kind, { sessionId: 'private' })).status, 403);
    assert.equal((await h.http(kind, { sessionId: 'installed' })).status, 403);
    assert.equal((await h.http(kind, { path: 'secret.txt' })).status, 403);
  }
});

test('real Windows junctions cannot expose outside, account, or runtime; internal links work', options, async t => {
  const h = await harness(t), linkType = process.platform === 'win32' ? 'junction' : 'dir';
  const nested = path.join(h.workspace, 'nested'); fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, 'clip.mp4'), bytes); fs.writeFileSync(path.join(nested, 'clip.mp3'), bytes);
  for (const [name, dir] of [['outside-link', h.outside], ['account-link', h.other], ['runtime-link', h.runtime], ['safe-link', nested]]) fs.symlinkSync(dir, path.join(h.workspace, name), linkType);
  for (const kind of ['video', 'audio']) {
    const ext = kind === 'video' ? 'mp4' : 'mp3';
    for (const name of ['outside-link', 'account-link', 'runtime-link']) assert.equal((await h.http(kind, { path: `${name}/clip.${ext}` })).status, 403);
    const safe = await h.http(kind, { path: `safe-link/clip.${ext}` }); assert.equal(safe.status, 200); assert.deepEqual(safe.body, bytes);
  }
});

test('empty files, missing files and unsupported methods retain defined behavior without leaking host paths', options, async t => {
  const h = await harness(t);
  fs.writeFileSync(path.join(h.workspace, 'empty.mp3'), ''); fs.writeFileSync(path.join(h.workspace, 'empty.mp4'), '');
  const empty = await h.http('audio', { path: 'empty.mp3' }); assert.equal(empty.status, 200); assert.equal(empty.body.length, 0);
  assert.equal((await h.http('audio', { path: 'empty.mp3' }, { headers: { range: 'bytes=0-' } })).status, 416);
  assert.equal((await h.http('video', { path: 'empty.mp4' })).status, 400);
  for (const kind of ['video', 'audio']) {
    const missing = await h.http(kind, { path: kind === 'video' ? 'missing.mp4' : 'missing.mp3' });
    assert.equal(missing.status, 404); assert.equal(missing.body.includes(Buffer.from(h.workspace)), false);
    assert.equal((await h.http(kind, {}, { method: 'POST' })).status, 405);
  }
});

test('published clients register compatible none/custom viewers through the existing registry', options, t => {
  const registrations = [];
  for (const [name, file] of [[packages[0], 'client.js'], [packages[1], 'lib/client.js']]) {
    const document = { getElementById: () => ({}), createElement: () => ({}), head: { appendChild() {} } };
    let client;
    runInNewContext(fs.readFileSync(path.join(source, 'node_modules', name, file), 'utf8'), {
      window: { __ModuleLoader__: { load({ factory }) { client = factory(id => {
        assert.ok(['react', 'react/jsx-runtime'].includes(id), id); return {};
      }); } } }, document, URL, URLSearchParams, console,
    });
    assert.deepEqual([...client.inject], ['betterSidebar']);
    client.apply({ betterSidebar: { registerFileViewer(viewer) { registrations.push(viewer); return () => {}; } }, effect(fn) { fn(); } });
  }
  assert.equal(registrations[0].fetchStrategy, 'none');
  assert.equal(registrations[1].fetchStrategy, 'custom');
  assert.equal(registrations[1].priority, 50);
  assert.ok(registrations[0].exts.includes('mp4')); assert.ok(registrations[1].exts.includes('mp3'));
});

test('offline player assets require admission, use a fixed allowlist and cannot expose files outside the runtime', options, async t => {
  const h = await harness(t);
  for (const name of ['avplayer.js', 'wasm/decode/mpeg4-simd.wasm']) {
    const pathname = '/rufa-media-player/' + name;
    assert.equal((await h.http('video', {}, { pathname, headers: { authorization: '' } })).status, 401);
    assert.equal((await h.http('video', {}, { pathname, headers: { origin: 'https://evil.invalid' } })).status, 403);
    const result = await h.http('video', {}, { pathname });
    assert.equal(result.status, 200); assert.ok(result.body.length > 0);
    assert.equal(result.headers['content-type'], name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript; charset=utf-8');
    const head = await h.http('video', {}, { pathname, method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(head.body.length, 0);
    assert.equal(head.headers['content-length'], String(result.body.length));
    assert.equal((await h.http('video', {}, { pathname, method: 'POST' })).status, 405);
  }
  for (const pathname of ['/rufa-media-player/unknown.js', '/rufa-media-player/PLAYER-LOCK.json', '/rufa-media-player/%2e%2e%2fsecret.txt', '/rufa-media-player/wasm/encode/mpeg4-simd.wasm'])
    assert.equal((await h.http('video', {}, { pathname })).status, 404);
  const root = path.join(h.runtime, 'company-tools/media-player'), original = path.join(root, 'wasm/decode');
  fs.renameSync(original, path.join(root, 'saved-decode'));
  fs.writeFileSync(path.join(h.outside, 'mpeg4-simd.wasm'), bytes);
  fs.symlinkSync(h.outside, original, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await h.http('video', {}, { pathname: '/rufa-media-player/wasm/decode/mpeg4-simd.wasm' })).status, 403);
});

test('conversion endpoints are removed; media stays the exact original and no account preview cache is created', options, async t => {
  const h = await harness(t);
  for (const kind of ['video', 'audio']) {
    const prefix = kind === 'video' ? '/video/preview/' : '/audio-preview/preview/';
    for (const action of ['prepare', 'status', 'media', 'release']) {
      assert.equal((await h.http(kind, {}, { pathname: prefix + action })).status, 404);
      assert.equal((await h.http(kind, {}, { pathname: prefix + action, method: 'POST' })).status, 405);
    }
    assert.deepEqual((await h.http(kind)).body, bytes);
  }
  assert.equal(fs.existsSync(path.join(h.home, 'company-media-preview')), false);
});
