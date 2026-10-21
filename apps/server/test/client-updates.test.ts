import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer, get, type ClientRequest, type IncomingMessage } from 'node:http';
import { link, mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { buildApp } from '../src/app.js';
import { configFromEnv, type ServerConfig } from '../src/config.js';
import { ClientReleaseRepository, isReleaseVersion } from '../src/client-updates.js';
import { hashPassword } from '../src/security.js';
import { MemoryStore } from './memory-store.js';

const base = '/api/v1/client-updates/windows/x64';
const sha512 = (bytes: Buffer) => createHash('sha512').update(bytes).digest('base64');
async function fixture(t: TestContext, config: Partial<ServerConfig> = {}) {
  const temporary = await mkdtemp(join(tmpdir(), 'rufa-client-updates-'));
  const root = join(temporary, 'client-releases');
  const store = new MemoryStore();
  const app = buildApp(store, { ...configFromEnv({}), ...config, clientReleasesDir: root });
  t.after(async () => {
    await app.close();
    assert.equal(dirname(resolve(temporary)), resolve(tmpdir()));
    assert.ok(basename(temporary).startsWith('rufa-client-updates-'));
    await rm(temporary, { recursive: true, force: true });
  });
  async function publish(version = '0.2.0', blockmap = false) {
    const name = `Rufa-DSH-${version}-x64-Setup.exe`, directory = join(root, 'releases', version);
    const bytes = Buffer.from('MZ synthetic installer bytes 0123456789\0\xff', 'latin1');
    const map = Buffer.from('synthetic optional blockmap');
    const file = { url: `releases/${version}/${name}`, sha512: sha512(bytes), size: bytes.length };
    const manifest = { version, releaseDate: '2026-10-20T12:00:00.000Z', files: [file], path: file.url, sha512: file.sha512,
      ...(blockmap ? { blockmap: { size: map.length, sha512: sha512(map) } } : {}) };
    await mkdir(directory, { recursive: true }); await writeFile(join(directory, name), bytes);
    if (blockmap) await writeFile(join(directory, `${name}.blockmap`), map);
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
    await writeFile(join(root, 'next.json'), JSON.stringify({ version }));
    await rename(join(root, 'next.json'), join(root, 'current.json'));
    return { version, name, directory, bytes, map, manifest, url: `${base}/releases/${version}/${name}` };
  }
  return { root, app, publish, temporary, store };
}

test('unpublished server starts normally; public GET/HEAD return 404 without creating files', async t => {
  const f = await fixture(t);
  for (const method of ['GET', 'HEAD'] as const) assert.equal((await f.app.inject({ method, url: `${base}/latest.yml` })).statusCode, 404);
  assert.equal((await f.app.inject('/health/ready')).statusCode, 200);
  await assert.rejects(readFile(join(f.root, 'current.json')), { code: 'ENOENT' });
  assert.equal((await f.app.inject('/api/v1/client-updates/linux/x64/latest.yml')).statusCode, 404);
});

test('latest is GenericProvider JSON/YAML with only validated public fields and no authentication', async t => {
  const f = await fixture(t), p = await f.publish('0.2.0', true);
  await writeFile(join(p.directory, 'manifest.json'), JSON.stringify({ ...p.manifest, privatePath: 'not-public', apiKey: 'synthetic-not-public' }));
  const latest = await f.app.inject(`${base}/latest.yml?noCache=123`);
  assert.equal(latest.statusCode, 200, latest.body); assert.match(String(latest.headers['content-type']), /yaml/);
  assert.match(String(latest.headers['cache-control']), /no-store/); assert.equal(latest.headers['x-content-type-options'], 'nosniff');
  const { blockmap: _map, ...expected } = p.manifest;
  assert.deepEqual(latest.json(), expected); assert(!latest.body.includes('not-public'));
  const head = await f.app.inject({ method: 'HEAD', url: `${base}/latest.yml` });
  assert.equal(head.statusCode, 200); assert.equal(head.body, '');
  assert.equal(head.headers.etag, latest.headers.etag); assert.equal(Number(head.headers['content-length']), Buffer.byteLength(latest.body));
  const unchanged = await f.app.inject({ url: `${base}/latest.yml`, headers: { 'if-none-match': String(latest.headers.etag) } });
  assert.equal(unchanged.statusCode, 304); assert.equal(unchanged.body, ''); assert.match(String(unchanged.headers['cache-control']), /no-store/);
});

test('declared installer/blockmap bytes, sizes, ETags and HEAD agree; other routes remain private', async t => {
  const f = await fixture(t), p = await f.publish('0.2.0', true);
  for (const [url, bytes] of [[p.url, p.bytes], [`${p.url}.blockmap`, p.map]] as const) {
    const get = await f.app.inject(url); assert.equal(get.statusCode, 200, get.body); assert.deepEqual(get.rawPayload, bytes);
    assert.equal(Number(get.headers['content-length']), bytes.length); assert.match(String(get.headers['cache-control']), /immutable/);
    assert.equal(get.headers['accept-ranges'], 'bytes');
    const head = await f.app.inject({ method: 'HEAD', url }); assert.equal(head.statusCode, 200); assert.equal(head.body, '');
    assert.equal(head.headers.etag, get.headers.etag); assert.equal(head.headers['content-length'], get.headers['content-length']);
    const cached = await f.app.inject({ url, headers: { 'if-none-match': `W/${get.headers.etag}` } });
    assert.equal(cached.statusCode, 304); assert.equal(cached.body, '');
  }
  const privateReply = await f.app.inject('/api/v1/auth/me');
  assert.equal(privateReply.statusCode, 401); assert.equal(privateReply.headers['cache-control'], 'no-store');
  assert.equal((await f.app.inject({ method: 'POST', url: p.url })).statusCode, 404);
});

test('single bounded, open, suffix, oversize ranges and If-Range produce exact slices', async t => {
  const f = await fixture(t), p = await f.publish();
  for (const [range, start, end] of [['bytes=0-3', 0, 3], ['bytes=5-', 5, p.bytes.length - 1], ['bytes=-4', p.bytes.length - 4, p.bytes.length - 1], ['bytes=2-99999999999999999999', 2, p.bytes.length - 1], ['bytes=-99999999999999999999', 0, p.bytes.length - 1]] as const) {
    const response = await f.app.inject({ url: p.url, headers: { range } });
    assert.equal(response.statusCode, 206, response.body); assert.deepEqual(response.rawPayload, p.bytes.subarray(start, end + 1));
    assert.equal(response.headers['content-range'], `bytes ${start}-${end}/${p.bytes.length}`);
    assert.equal(Number(response.headers['content-length']), end - start + 1);
  }
  const full = await f.app.inject(p.url);
  const partial = await f.app.inject({ method: 'HEAD', url: p.url, headers: { range: 'bytes=1-4', 'if-range': String(full.headers.etag) } });
  assert.equal(partial.statusCode, 206); assert.equal(partial.body, ''); assert.equal(Number(partial.headers['content-length']), 4);
  for (const validator of ['"different-file"', `W/${full.headers.etag}`, 'Mon, 01 Jan 2001 00:00:00 GMT']) {
    const response = await f.app.inject({ url: p.url, headers: { range: 'bytes=1-4', 'if-range': validator } });
    assert.equal(response.statusCode, 200); assert.deepEqual(response.rawPayload, p.bytes);
  }
});

test('malformed, multiple and unsatisfiable ranges return empty 416 without immutable caching', async t => {
  const f = await fixture(t), p = await f.publish();
  for (const range of ['bytes=999-', 'bytes=7-2', 'bytes=-0', 'bytes=-', 'bytes=0-1,3-4', 'items=0-1', 'bytes=x-y', `bytes=${'9'.repeat(130)}-`]) {
    const response = await f.app.inject({ url: p.url, headers: { range } });
    assert.equal(response.statusCode, 416, range); assert.equal(response.headers['content-range'], `bytes */${p.bytes.length}`);
    assert.equal(response.body, ''); assert.equal(response.headers['cache-control'], 'no-store');
  }
});

test('atomic current switch changes latest while old immutable releases remain downloadable', async t => {
  const f = await fixture(t), old = await f.publish('0.2.0');
  const first = await f.app.inject(`${base}/latest.yml`); await f.publish('0.3.0');
  const next = await f.app.inject({ url: `${base}/latest.yml`, headers: { 'if-none-match': String(first.headers.etag) } });
  assert.equal(next.statusCode, 200); assert.equal(next.json().version, '0.3.0'); assert.notEqual(next.headers.etag, first.headers.etag);
  assert.deepEqual((await f.app.inject(old.url)).rawPayload, old.bytes);
});

test('same-size corruption invalidates a cached release, including conditional requests', async t => {
  const f = await fixture(t), p = await f.publish();
  const first = await f.app.inject(p.url); assert.equal(first.statusCode, 200);
  const damaged = Buffer.from(p.bytes); damaged[5] ^= 0xff; await writeFile(join(p.directory, p.name), damaged);
  const next = await f.app.inject({ url: p.url, headers: { 'if-none-match': String(first.headers.etag) } });
  assert.equal(next.statusCode, 503); assert(!next.body.includes(p.directory)); assert.equal(next.headers['cache-control'], 'no-store');
  assert.equal((await f.app.inject(`${base}/latest.yml`)).statusCode, 503);
  await writeFile(join(p.directory, p.name), p.bytes);
  assert.equal((await f.app.inject(`${base}/latest.yml`)).statusCode, 200);
});

test('declared missing, truncated and corrupt blockmap prevents publishing the whole release', async t => {
  const f = await fixture(t), p = await f.publish('0.2.0', true), file = join(p.directory, `${p.name}.blockmap`);
  for (const corruption of ['missing', 'size', 'hash']) {
    if (corruption === 'missing') await unlink(file);
    else await writeFile(file, corruption === 'size' ? Buffer.from('short') : Buffer.alloc(p.map.length, 65));
    assert.equal((await f.app.inject(`${base}/latest.yml`)).statusCode, 503);
    assert.equal((await f.app.inject(p.url)).statusCode, 503);
  }
});

test('undeclared side files and guessed installer names are never served', async t => {
  const f = await fixture(t), p = await f.publish();
  await writeFile(join(p.directory, `${p.name}.blockmap`), 'not declared');
  await writeFile(join(p.directory, 'other.exe'), 'private');
  for (const filename of [`${p.name}.blockmap`, 'manifest.json', 'other.exe', 'current.json', 'secrets.json']) {
    assert.equal((await f.app.inject(`${base}/releases/${p.version}/${filename}`)).statusCode, 404);
  }
  assert.equal((await f.app.inject(`${base}/latest.yml`)).statusCode, 200);
});

test('stable three-part versions and exact installer names reject incompatible releases and traversal', async t => {
  for (const version of ['0.2.0', '1.2.3', '999999999.999999999.999999999']) assert.equal(isReleaseVersion(version), true);
  for (const version of ['v0.2.0', '01.2.0', '1.2', '1.2.3-01', '1.2.3-rc.1', '1.2.3+build.01', '1000000000.2.3', '..', '1.2.3/a', '1.2.3\\x']) assert.equal(isReleaseVersion(version), false);
  const f = await fixture(t), p = await f.publish();
  for (const path of ['%2e%2e/secret.exe', '0.2.0/%2e%2e%2fsecret.exe', '0.2.0/%2e%2e%5csecret.exe', '0.2.0/C%3Asecret.exe', '0.2.0/%00.exe', '0.2.0/nested%2ffile.exe']) {
    const response = await f.app.inject(`${base}/releases/${path}`); assert(response.statusCode >= 400); assert(!response.body.includes('MZ synthetic'));
  }
  for (const url of ['https://example.invalid/x.exe', `releases/${p.version}/../secret.exe`, `releases/${p.version}/C:secret.exe`, `releases/${p.version}/x%2f.exe`, `releases/${p.version}/other.exe`, `releases/${p.version}/Rufa-DSH-0.3.0-x64-Setup.exe`]) {
    await writeFile(join(p.directory, 'manifest.json'), JSON.stringify({ ...p.manifest, path: url, files: [{ ...p.manifest.files[0], url }] }));
    assert.equal((await f.app.inject(`${base}/latest.yml`)).statusCode, 503);
  }
});

test('release directory junction/symlink and hardlinked artifact fail closed', async t => {
  const f = await fixture(t), p = await f.publish();
  const moved = join(f.temporary, 'elsewhere'); await rename(p.directory, moved);
  await symlink(moved, p.directory, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await f.app.inject(`${base}/latest.yml`)).statusCode, 503);
  await unlink(p.directory); await rename(moved, p.directory);
  await link(join(p.directory, p.name), join(f.temporary, 'outside.exe'));
  assert.equal((await f.app.inject(`${base}/latest.yml`)).statusCode, 503);
});

test('replacement between validation and download is rejected on the opened file descriptor', async t => {
  const f = await fixture(t), p = await f.publish(), repository = new ClientReleaseRepository(f.root);
  const release = await repository.latest();
  await rename(join(p.directory, p.name), join(p.directory, 'old.exe'));
  await writeFile(join(p.directory, p.name), p.bytes);
  await assert.rejects(repository.openArtifact(release, release.artifacts[0]), { code: 'CLIENT_RELEASE_UNAVAILABLE' });
});

test('invalid/oversized current and mismatched or incomplete manifest never become latest', async t => {
  const f = await fixture(t), p = await f.publish();
  for (const pointer of ['{', JSON.stringify({ version: '../secrets' }), ' '.repeat(17000), JSON.stringify({ version: p.version, extra: true })]) {
    await writeFile(join(f.root, 'current.json'), pointer);
    assert.equal((await f.app.inject(`${base}/latest.yml`)).statusCode, 503);
  }
  await writeFile(join(f.root, 'current.json'), JSON.stringify({ version: p.version }));
  for (const manifest of [{ ...p.manifest, version: '0.3.0' }, { ...p.manifest, sha512: 'bad' }, { ...p.manifest, files: [] }, { ...p.manifest, releaseDate: 'not-a-date' }]) {
    await writeFile(join(p.directory, 'manifest.json'), JSON.stringify(manifest));
    assert.equal((await f.app.inject(`${base}/latest.yml`)).statusCode, 503);
  }
  await writeFile(join(f.root, 'current.json'), JSON.stringify({ version: '9.9.9' }));
  assert.equal((await f.app.inject(`${base}/latest.yml`)).statusCode, 503);
  assert.equal((await f.app.inject(`${base}/releases/9.9.9/absent.exe`)).statusCode, 404);
});

test('concurrent metadata checks share streaming validation and keep health available', async t => {
  const f = await fixture(t); await f.publish();
  const results = await Promise.all(Array.from({ length: 12 }, () => f.app.inject(`${base}/latest.yml`)));
  assert(results.every(r => r.statusCode === 200));
  assert.equal((await f.app.inject('/health/ready')).statusCode, 200);
  assert.equal(configFromEnv({ RUFA_CLIENT_RELEASES_DIR: f.root }).clientReleasesDir, f.root);
});

test('real slow downloads have separate capacity from model calls and aborts release every slot', { timeout: 20000 }, async t => {
  let upstreamCalls = 0;
  const upstream = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Consume synthetic model input. */ }
    upstreamCalls++;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'synthetic ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  t.after(async () => { upstream.closeAllConnections(); await new Promise<void>(done => upstream.close(() => done())); });
  const f = await fixture(t, { maxConcurrent: 1, maxUserConcurrent: 1, upstreamKey: 'synthetic-local-test', allowInsecureUpstream: true,
    upstreamBaseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}` });
  const p = await f.publish();
  const bytes = Buffer.alloc(32 * 1024 * 1024, 0x5a); bytes.write('MZ');
  const file = { ...p.manifest.files[0], size: bytes.length, sha512: sha512(bytes) };
  await writeFile(join(p.directory, p.name), bytes);
  await writeFile(join(p.directory, 'manifest.json'), JSON.stringify({ ...p.manifest, files: [file], sha512: file.sha512 }));
  const password = 'synthetic-update-test-password';
  await f.store.createUser({ username: 'update-tester', displayName: '测试', role: 'employee', passwordHash: await hashPassword(password) });
  const login = await f.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'update-tester', password } });
  assert.equal(login.statusCode, 200);
  const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
  const held: { request: ClientRequest; response: IncomingMessage }[] = [];
  try {
    for (let index = 0; index < 8; index++) {
      const request = get(`${address}${p.url}`);
      request.on('error', () => {});
      const [response] = await once(request, 'response') as [IncomingMessage];
      response.on('error', () => {}); response.pause();
      held.push({ request, response }); assert.equal(response.statusCode, 200);
    }
    const busy = await f.app.inject({ url: p.url, headers: { range: 'bytes=0-3' } });
    assert.equal(busy.statusCode, 503, busy.body); assert.equal(busy.json().error.code, 'CLIENT_RELEASE_BUSY');
    assert.equal(busy.headers['retry-after'], '5'); assert.equal(busy.headers['content-range'], undefined);
    assert.equal(busy.headers['cache-control'], 'no-store');
    const model = await f.app.inject({ method: 'POST', url: '/api/v1/gateway/deepseek/chat/completions', headers: { authorization: `Bearer ${login.json().accessToken}` },
      payload: { model: 'deepseek-flash', messages: [{ role: 'user', content: 'synthetic request' }] } });
    assert.equal(model.statusCode, 200, model.body); assert.equal(upstreamCalls, 1);
    assert.equal((await f.app.inject(`${base}/latest.yml`)).statusCode, 200);
    for (const value of held) { value.response.destroy(); value.request.destroy(); }
    // Wait on the actual sockets, then allow descriptor close callbacks to run.
    for (let attempt = 0; attempt < 100 && f.app.server.listening; attempt++) {
      const response = await f.app.inject({ url: p.url, headers: { range: 'bytes=0-1' } });
      if (response.statusCode === 206) break;
      assert.equal(response.statusCode, 503); await new Promise(done => setTimeout(done, 10));
    }
    const responses = await Promise.all(Array.from({ length: 8 }, () => f.app.inject({ url: p.url, headers: { range: 'bytes=0-1023' } })));
    assert(responses.every(response => response.statusCode === 206), responses.map(response => response.statusCode).join(','));
    for (const response of responses) assert.deepEqual(response.rawPayload, bytes.subarray(0, 1024));
  } finally {
    for (const value of held) { value.response.destroy(); value.request.destroy(); }
    f.app.server.closeAllConnections();
  }
});
