import assert from 'node:assert/strict';
import { constants, createHash, generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import { get, type ClientRequest, type IncomingMessage } from 'node:http';
import { link, mkdir, mkdtemp, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { buildApp } from '../src/app.js';
import { ClientIncrementalRepository, INCREMENTAL_MANIFEST_MAX_BYTES, INCREMENTAL_MAX_FILES, parseIncrementalManifest, validIncrementalPath } from '../src/client-incremental-updates.js';
import { UpdateCapacity } from '../src/client-update-files.js';
import { configFromEnv } from '../src/config.js';
import { MemoryStore } from './memory-store.js';

const prefix = '/api/v1/client-updates/windows/x64', date = '2026-10-21T12:00:00.000Z';
const keys = generateKeyPairSync('rsa', { modulusLength: 3072 });
const publicPem = keys.publicKey.export({ type: 'spki', format: 'pem' });
const keyId = createHash('sha256').update(keys.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const sha512 = (bytes: Buffer) => createHash('sha512').update(bytes).digest('base64');
const signature = (bytes: Buffer) => sign('sha256', bytes, { key: keys.privateKey, padding: constants.RSA_PKCS1_PADDING }).toString('base64');
const defaults: [string, Buffer][] = [['Rufajx-DSH-App.exe', Buffer.from('MZ synthetic app')], ['resources/app.asar', Buffer.from('synthetic application bytes 0123456789')], ['resources/empty.txt', Buffer.alloc(0)]];

async function fixture(t: TestContext, configureKey = true) {
  const temporary = await mkdtemp(join(tmpdir(), 'rufa-incremental-test-')), root = join(temporary, 'releases-root'), publicKeyFile = join(temporary, 'public.pem');
  await writeFile(publicKeyFile, publicPem);
  const app = buildApp(new MemoryStore(), { ...configFromEnv({}), clientReleasesDir: root, clientUpdatePublicKeyFile: configureKey ? publicKeyFile : undefined });
  t.after(async () => {
    await app.close(); assert.equal(dirname(resolve(temporary)), resolve(tmpdir())); assert.ok(basename(temporary).startsWith('rufa-incremental-test-'));
    await rm(temporary, { recursive: true, force: true });
  });
  const objectPath = (hash: string) => join(root, 'objects', 'sha256', hash.slice(0, 2), hash);
  async function publish(version = '0.3.0', entries = defaults, incremental = true) {
    entries = [...entries, ...defaults.slice(0, 2).filter(([path]) => !entries.some(([name]) => name === path))];
    const directory = join(root, 'releases', version), installerName = `Rufa-DSH-${version}-x64-Setup.exe`, installerBytes = Buffer.from(`MZ synthetic full ${version}`);
    await mkdir(directory, { recursive: true }); await writeFile(join(directory, installerName), installerBytes);
    const file = { url: `releases/${version}/${installerName}`, size: installerBytes.length, sha512: sha512(installerBytes) };
    const legacy: any = { version, releaseDate: date, files: [file], path: file.url, sha512: file.sha512 };
    const manifest: any = { schema: 1, version, platform: 'win32', arch: 'x64', releaseDate: date, minUpdaterVersion: '0.3.0', files: entries.map(([path, bytes]) => ({ path, size: bytes.length, sha256: sha256(bytes), sha512: sha512(bytes) })) };
    for (const [, bytes] of entries) { const target = objectPath(sha256(bytes)); await mkdir(dirname(target), { recursive: true }); try { await writeFile(target, bytes, { flag: 'wx' }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; } }
    const writeMetadata = () => writeFile(join(directory, 'manifest.json'), JSON.stringify(legacy));
    async function resign(value: unknown = manifest, patch: Record<string, unknown> = {}) {
      const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
      await writeFile(join(directory, 'incremental-manifest.json'), bytes);
      legacy.incremental = { url: `releases/${version}/incremental-manifest.json`, size: bytes.length, sha512: sha512(bytes), algorithm: 'rsa-sha256', keyId, signature: signature(bytes), ...patch };
      await writeMetadata(); return bytes;
    }
    const bytes = incremental ? await resign() : undefined; if (!incremental) await writeMetadata();
    await writeFile(join(root, 'next.json'), JSON.stringify({ version })); await rename(join(root, 'next.json'), join(root, 'current.json'));
    const payloadUrl = (hash = manifest.files[0].sha256) => `${prefix}/releases/${version}/payloads/${hash}`;
    return { version, directory, legacy, manifest, bytes, installerName, installerBytes, resign, writeMetadata, payloadUrl,
      manifestUrl: `${prefix}/releases/${version}/incremental-manifest.json`, installerUrl: `${prefix}/${file.url}` };
  }
  return { root, temporary, publicKeyFile, app, publish, objectPath };
}

test('incremental unpublished/legacy-only routes return 404 and keep existing EXE feed available', async t => {
  const f = await fixture(t);
  assert.equal((await f.app.inject(`${prefix}/incremental/latest.json`)).statusCode, 404);
  const p = await f.publish('0.2.3', defaults, false);
  assert.equal((await f.app.inject(`${prefix}/incremental/latest.json`)).statusCode, 404);
  assert.equal((await f.app.inject(p.manifestUrl)).statusCode, 404);
  assert.equal((await f.app.inject(p.payloadUrl())).statusCode, 404);
  assert.equal((await f.app.inject(`${prefix}/latest.yml`)).json().version, '0.2.3');
  assert.deepEqual((await f.app.inject(p.installerUrl)).rawPayload, p.installerBytes);
});

test('signed latest projects only fixed public fields; legacy stays compatible and manifest bytes stay exact', async t => {
  const f = await fixture(t), p = await f.publish(); p.legacy.privateField = 'synthetic-private'; await p.writeMetadata();
  const latest = await f.app.inject(`${prefix}/incremental/latest.json`); assert.equal(latest.statusCode, 200, latest.body);
  assert.deepEqual(latest.json(), { schema: 1, version: p.version, releaseDate: date, minUpdaterVersion: '0.3.0', manifest: p.legacy.incremental, installer: p.legacy.files[0] });
  assert.match(String(latest.headers['cache-control']), /no-store/); assert.ok(!latest.body.includes('synthetic-private'));
  const head = await f.app.inject({ method: 'HEAD', url: `${prefix}/incremental/latest.json` }); assert.equal(head.body, ''); assert.equal(head.headers['content-length'], latest.headers['content-length']);
  const cached = await f.app.inject({ url: `${prefix}/incremental/latest.json`, headers: { 'if-none-match': String(latest.headers.etag) } }); assert.equal(cached.statusCode, 304); assert.match(String(cached.headers['cache-control']), /no-store/);
  const legacy = await f.app.inject(`${prefix}/latest.yml`); const { incremental: _i, privateField: _p, ...original } = p.legacy; assert.deepEqual(legacy.json(), original);
  const manifest = await f.app.inject(p.manifestUrl); assert.equal(manifest.statusCode, 200); assert.deepEqual(manifest.rawPayload, p.bytes); assert.equal(sha512(manifest.rawPayload), p.legacy.incremental.sha512); assert.match(String(manifest.headers['cache-control']), /immutable/);
  assert.equal((await f.app.inject('/api/v1/auth/me')).statusCode, 401);
});

test('CAS objects are version members, preserve raw bytes and do not expose guessed/unreleased files', async t => {
  const f = await fixture(t), p = await f.publish();
  for (const [index, [, bytes]] of defaults.entries()) {
    const response = await f.app.inject(p.payloadUrl(p.manifest.files[index].sha256)); assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.rawPayload, bytes); assert.equal(Number(response.headers['content-length']), bytes.length);
  }
  const secret = Buffer.from('synthetic-unreleased'), hash = sha256(secret); await mkdir(dirname(f.objectPath(hash)), { recursive: true }); await writeFile(f.objectPath(hash), secret);
  assert.equal((await f.app.inject(p.payloadUrl(hash))).statusCode, 404);
  for (const route of [`${prefix}/objects/sha256/${hash.slice(0, 2)}/${hash}`, `${prefix}/releases/${p.version}/manifest.json`, `${prefix}/releases/${p.version}/payloads`, p.payloadUrl(hash.toUpperCase()), p.payloadUrl('%2e%2e%2fsecret')]) assert.ok((await f.app.inject(route)).statusCode >= 400);
  assert.equal((await f.app.inject({ method: 'POST', url: p.payloadUrl(), payload: 'no upload' })).statusCode, 404);
});

test('CAS nonempty and manifest single Range/If-Range/HEAD/304 match original byte boundaries', async t => {
  const f = await fixture(t), p = await f.publish();
  for (const [url, bytes] of [[p.payloadUrl(p.manifest.files[1].sha256), defaults[1][1]], [p.manifestUrl, p.bytes!]] as const) {
    const whole = await f.app.inject(url);
    for (const [range, start, end] of [['bytes=0-3', 0, 3], ['bytes=4-', 4, bytes.length - 1], ['bytes=-5', bytes.length - 5, bytes.length - 1], ['bytes=1-99999999999999999', 1, bytes.length - 1]] as const) {
      const response = await f.app.inject({ url, headers: { range } }); assert.equal(response.statusCode, 206, response.body); assert.deepEqual(response.rawPayload, bytes.subarray(start, end + 1));
      assert.equal(response.headers['content-range'], `bytes ${start}-${end}/${bytes.length}`);
    }
    const head = await f.app.inject({ method: 'HEAD', url, headers: { range: 'bytes=0-3', 'if-range': String(whole.headers.etag) } }); assert.equal(head.statusCode, 206); assert.equal(head.body, ''); assert.equal(head.headers['content-length'], '4');
    assert.equal((await f.app.inject({ url, headers: { range: 'bytes=0-3', 'if-range': '"wrong"' } })).statusCode, 200);
    assert.equal((await f.app.inject({ url, headers: { 'if-none-match': String(whole.headers.etag) } })).statusCode, 304);
    for (const range of ['bytes=0-1,3-4', 'bytes=-0', 'bytes=999999999-', 'items=0-3']) { const r = await f.app.inject({ url, headers: { range } }); assert.equal(r.statusCode, 416); assert.equal(r.headers['cache-control'], 'no-store'); }
  }
});

test('zero-byte CAS objects support GET/HEAD and have no satisfiable Range', async t => {
  const f = await fixture(t), p = await f.publish(), url = p.payloadUrl(p.manifest.files[2].sha256);
  for (const method of ['GET', 'HEAD'] as const) {
    const full = await f.app.inject({ method, url }); assert.equal(full.statusCode, 200); assert.equal(full.headers['content-length'], '0'); assert.equal(full.body, '');
    for (const range of ['bytes=0-', 'bytes=-1', 'bytes=0-0']) { const r = await f.app.inject({ method, url, headers: { range } }); assert.equal(r.statusCode, 416); assert.equal(r.headers['content-range'], 'bytes */0'); assert.equal(r.body, ''); }
  }
});

test('missing/mismatched/private/unsupported public key blocks only incremental routes', async t => {
  const missing = await fixture(t, false), absent = await missing.publish(); assert.equal((await missing.app.inject(absent.manifestUrl)).statusCode, 503); assert.equal((await missing.app.inject(`${prefix}/latest.yml`)).statusCode, 200);
  const f = await fixture(t), p = await f.publish(); const ed = generateKeyPairSync('ed25519'), weak = generateKeyPairSync('rsa', { modulusLength: 2048 });
  for (const contents of ['invalid', keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), ed.publicKey.export({ type: 'spki', format: 'pem' }), weak.publicKey.export({ type: 'spki', format: 'pem' })]) {
    await writeFile(f.publicKeyFile, contents); assert.equal((await f.app.inject(`${prefix}/incremental/latest.json`)).statusCode, 503); assert.equal((await f.app.inject(`${prefix}/latest.yml`)).statusCode, 200); assert.equal((await f.app.inject('/health/ready')).statusCode, 200);
  }
  await unlink(f.publicKeyFile); assert.equal((await f.app.inject(p.payloadUrl())).statusCode, 503);
  assert.equal(configFromEnv({ RUFA_CLIENT_UPDATE_PUBLIC_KEY_FILE: 'public.pem' }).clientUpdatePublicKeyFile, 'public.pem');
});

test('signature algorithm/keyId/base64/length and actual RSA signature are mandatory on metadata and payload routes', async t => {
  const f = await fixture(t), p = await f.publish();
  for (const patch of [{ algorithm: 'ed25519' }, { keyId: '0'.repeat(64) }, { signature: Buffer.alloc(384, 1).toString('base64') }, { signature: 'A'.repeat(511) }, { signature: 'A'.repeat(512) + '=' }, { signature: 'A'.repeat(86) + '==' }, { extra: 'not-public' }, { url: 'https://example.invalid/manifest.json' }]) {
    await p.resign(p.manifest, patch);
    for (const url of [`${prefix}/incremental/latest.json`, p.manifestUrl, p.payloadUrl()]) { const r = await f.app.inject(url); assert.equal(r.statusCode, 503, `${url} ${r.body}`); assert.equal(r.headers['retry-after'], '5'); assert.ok(!r.body.includes(f.root)); }
    assert.equal((await f.app.inject(`${prefix}/latest.yml`)).statusCode, 200);
  }
});

test('manifest hash and signature bind raw bytes; cached conditional requests cannot mask corruption', async t => {
  const f = await fixture(t), p = await f.publish();
  const cached = await f.app.inject(p.manifestUrl); assert.equal(cached.statusCode, 200);
  const changed = Buffer.from(p.bytes!);
  changed[10] ^= 1; await writeFile(join(p.directory, 'incremental-manifest.json'), changed);
  assert.equal((await f.app.inject({ url: p.manifestUrl, headers: { 'if-none-match': String(cached.headers.etag) } })).statusCode, 503);
  p.legacy.incremental.sha512 = sha512(changed); await p.writeMetadata(); assert.equal((await f.app.inject(p.manifestUrl)).statusCode, 503, 'matching digest does not bypass signature');
  await p.resign(); assert.equal((await f.app.inject(p.manifestUrl)).statusCode, 200);
  await unlink(join(p.directory, 'incremental-manifest.json')); assert.equal((await f.app.inject(p.manifestUrl)).statusCode, 503);
});

test('manifest supports more than legacy 16KiB but enforces independent byte/count/schema limits', async t => {
  const f = await fixture(t), entries: [string, Buffer][] = Array.from({ length: 120 }, (_, i) => [`resources/files/${i}.txt`, Buffer.from('one reused synthetic object')]);
  const p = await f.publish('0.3.0', entries); assert.ok(p.bytes!.length > 16384); assert.equal((await f.app.inject(p.manifestUrl)).statusCode, 200);
  for (const patch of [{ size: INCREMENTAL_MANIFEST_MAX_BYTES + 1 }, { size: 1 }, { size: -1 }, { size: 1.5 }]) { await p.resign(p.manifest, patch); assert.equal((await f.app.inject(p.manifestUrl)).statusCode, 503); }
  const one = p.manifest.files[0];
  assert.throws(() => parseIncrementalManifest({ ...p.manifest, files: Array(INCREMENTAL_MAX_FILES + 1).fill(one) }, p.version, date));
  for (const patch of [{ schema: 2 }, { arch: 'arm64' }, { platform: 'linux' }, { version: '0.3.1' }, { releaseDate: 'wrong' }, { minUpdaterVersion: '0.2.3' }, { minUpdaterVersion: '0.4.0' }, { command: 'bad' }, { files: [] }]) { await p.resign({ ...p.manifest, ...patch }); assert.equal((await f.app.inject(p.manifestUrl)).statusCode, 503); }
});

test('Windows package paths reject traversal, namespaces, devices, reserved updater roots and collisions', async t => {
  const f = await fixture(t), p = await f.publish();
  const invalid = ['../x', '/x', 'C:/x', 'a\\b', 'a//b', 'a/./b', 'a/../b', 'a:b', 'a/CON.txt', 'aux', 'a/LPT¹.log', 'com²', 'a/NUL', 'a/CONOUT$', 'a.', 'a /b ', 'a\0b', 'a<b', 'a|b', 'a?b', 'a*b', 'a\ud800b', 'Rufajx-DSH.exe', 'rufajx-dsh.exe.config', 'Uninstall Rufajx-DSH.exe', '.rufa-update', '.RUFA-update/state.json', 'a'.repeat(256), Array(10).fill('a'.repeat(220)).join('/')];
  for (const path of invalid) { assert.equal(validIncrementalPath(path), false, path); await p.resign({ ...p.manifest, files: [{ ...p.manifest.files[0], path }] }); assert.equal((await f.app.inject(p.manifestUrl)).statusCode, 503, path); }
  for (const paths of [['a.txt', 'A.TXT'], ['a', 'a/b'], ['a/b', 'A']]) {
    await p.resign({ ...p.manifest, files: [...p.manifest.files, ...paths.map(path => ({ ...p.manifest.files[0], path }))] }); assert.equal((await f.app.inject(p.manifestUrl)).statusCode, 503);
  }
  for (const path of ['Rufajx-DSH-App.exe', 'resources/如发机械/内容.txt', 'resources/node_modules/@scope/a.js', `${'a'.repeat(240)}/b`]) assert.equal(validIncrementalPath(path), true, path);
});

test('same CAS hash cannot declare incompatible sizes/digests; invalid file fields never become public', async t => {
  const f = await fixture(t), p = await f.publish(), item = p.manifest.files[0];
  for (const patch of [{ size: item.size + 1 }, { sha512: sha512(Buffer.from('different')) }, { sha256: 'G'.repeat(64) }, { sha512: 'wrong' }, { size: -1 }, { url: 'https://example.invalid/file' }]) {
    await p.resign({ ...p.manifest, files: [...p.manifest.files, { ...item, path: 'resources/other', ...patch }] }); assert.equal((await f.app.inject(p.manifestUrl)).statusCode, 503);
  }
});

test('CAS cached same-size corruption, missing/truncated data and wrong sha256 fail before 304/Range', async t => {
  const f = await fixture(t), p = await f.publish(), file = p.manifest.files[0], target = f.objectPath(file.sha256);
  const cached = await f.app.inject(p.payloadUrl()); assert.equal(cached.statusCode, 200);
  await writeFile(target, Buffer.alloc(file.size, 65));
  for (const headers of [{ 'if-none-match': String(cached.headers.etag) }, { range: 'bytes=0-3' }]) assert.equal((await f.app.inject({ url: p.payloadUrl(), headers })).statusCode, 503);
  await writeFile(target, Buffer.from('short')); assert.equal((await f.app.inject(p.payloadUrl())).statusCode, 503);
  await unlink(target); assert.equal((await f.app.inject(p.payloadUrl())).statusCode, 503);
  await writeFile(target, defaults[0][1]); assert.equal((await f.app.inject(p.payloadUrl())).statusCode, 200);
  const fake = 'a'.repeat(64); await mkdir(dirname(f.objectPath(fake)), { recursive: true }); await writeFile(f.objectPath(fake), defaults[0][1]);
  await p.resign({ ...p.manifest, files: [{ ...file, sha256: fake }, ...p.manifest.files.slice(1)] }); assert.equal((await f.app.inject(p.payloadUrl(fake))).statusCode, 503);
});

test('CAS/manifest directory links and hardlinks are rejected without weakening legacy download isolation', async t => {
  const f = await fixture(t), p = await f.publish(), hash = p.manifest.files[0].sha256, target = f.objectPath(hash);
  await link(target, join(f.temporary, 'outside-copy')); assert.equal((await f.app.inject(p.payloadUrl())).statusCode, 503); await unlink(join(f.temporary, 'outside-copy'));
  const parent = dirname(target), elsewhere = join(f.temporary, 'object-dir'); await rename(parent, elsewhere); await symlink(elsewhere, parent, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await f.app.inject(p.payloadUrl())).statusCode, 503); await unlink(parent); await rename(elsewhere, parent);
  const manifest = join(p.directory, 'incremental-manifest.json'); await link(manifest, join(f.temporary, 'manifest-link')); assert.equal((await f.app.inject(p.manifestUrl)).statusCode, 503);
  assert.equal((await f.app.inject(`${prefix}/latest.yml`)).statusCode, 200);
});

test('opened payload/manifest descriptors detect same-byte pathname replacement after validation', async t => {
  const f = await fixture(t), p = await f.publish(), repo = new ClientIncrementalRepository(f.root, new UpdateCapacity(), f.publicKeyFile);
  const release = await repo.latest(), artifact = await repo.payload(release, p.manifest.files[0].sha256), target = f.objectPath(artifact.sha256);
  await rename(target, target + '.old'); await writeFile(target, defaults[0][1]); await assert.rejects(repo.openPayload(artifact), { code: 'CLIENT_RELEASE_UNAVAILABLE' });
  const path = join(p.directory, 'incremental-manifest.json'); await rename(path, path + '.old'); await writeFile(path, p.bytes!); await assert.rejects(repo.openManifest(release), { code: 'CLIENT_RELEASE_UNAVAILABLE' });
});

test('one atomic current pointer changes both feeds while older signed manifests and shared objects remain usable', async t => {
  const f = await fixture(t), old = await f.publish(); const before = await f.app.inject(`${prefix}/incremental/latest.json`);
  await f.publish('0.3.1'); const next = await f.app.inject({ url: `${prefix}/incremental/latest.json`, headers: { 'if-none-match': String(before.headers.etag) } });
  assert.equal(next.statusCode, 200); assert.equal(next.json().version, '0.3.1'); assert.equal((await f.app.inject(`${prefix}/latest.yml`)).json().version, '0.3.1');
  assert.equal((await f.app.inject(old.manifestUrl)).statusCode, 200); assert.deepEqual((await f.app.inject(old.payloadUrl())).rawPayload, defaults[0][1]);
  assert.equal((await f.app.inject(old.installerUrl)).statusCode, 200);
});

test('future minimum bootstrap version is retained in signed latest so older launchers can choose full installation', async t => {
  const f = await fixture(t), p = await f.publish('0.4.0'); await p.resign({ ...p.manifest, minUpdaterVersion: '0.4.0' });
  const latest = await f.app.inject(`${prefix}/incremental/latest.json`); assert.equal(latest.statusCode, 200); assert.equal(latest.json().minUpdaterVersion, '0.4.0');
  assert.equal(latest.json().installer.url, p.legacy.files[0].url);
});

test('signed full inventory requires both application entry and app.asar before any incremental route publishes', async t => {
  const f = await fixture(t), p = await f.publish();
  for (const path of ['Rufajx-DSH-App.exe', 'resources/app.asar']) {
    await p.resign({ ...p.manifest, files: p.manifest.files.filter((file: { path: string }) => file.path !== path) });
    for (const url of [`${prefix}/incremental/latest.json`, p.manifestUrl, p.payloadUrl(p.manifest.files[2].sha256)]) assert.equal((await f.app.inject(url)).statusCode, 503);
    assert.equal((await f.app.inject(`${prefix}/latest.yml`)).statusCode, 200);
  }
  await p.resign(); assert.equal((await f.app.inject(p.manifestUrl)).statusCode, 200);
});

test('hash and transfer admission are shared, bounded, independent and release only once', () => {
  const capacity = new UpdateCapacity(), first = capacity.hash(), second = capacity.hash(); assert.throws(() => capacity.hash(), { code: 'CLIENT_RELEASE_BUSY' });
  first(); first(); const replacement = capacity.hash(); assert.throws(() => capacity.hash(), { code: 'CLIENT_RELEASE_BUSY' });
  const transfers = Array.from({ length: 8 }, () => capacity.download()); assert.throws(() => capacity.download(), { code: 'CLIENT_RELEASE_BUSY' });
  transfers.forEach(done => done()); second(); replacement(); const done = capacity.hash(); done();
});

test('real mixed EXE/CAS slow downloads share eight slots; abort frees slots and latest/health remain available', { timeout: 25_000 }, async t => {
  const f = await fixture(t), large = Buffer.alloc(32 * 1024 * 1024, 0x5a), p = await f.publish('0.3.0', [['resources/large.bin', large]]);
  await writeFile(join(p.directory, p.installerName), large); p.legacy.files[0].size = large.length; p.legacy.files[0].sha512 = sha512(large); p.legacy.sha512 = sha512(large); await p.writeMetadata();
  const address = await f.app.listen({ host: '127.0.0.1', port: 0 }), held: { request: ClientRequest; response: IncomingMessage }[] = [];
  try {
    for (let i = 0; i < 8; i++) {
      const request = get(`${address}${i % 2 ? p.installerUrl : p.payloadUrl()}`); request.on('error', () => {});
      const [response] = await once(request, 'response') as [IncomingMessage]; response.on('error', () => {}); response.pause(); held.push({ request, response }); assert.equal(response.statusCode, 200);
    }
    for (const url of [p.installerUrl, p.payloadUrl(), p.manifestUrl]) { const r = await f.app.inject({ url, headers: { range: 'bytes=0-3' } }); assert.equal(r.statusCode, 503, r.body); assert.equal(r.headers['retry-after'], '5'); assert.equal(r.headers['content-range'], undefined); }
    assert.equal((await f.app.inject(`${prefix}/incremental/latest.json`)).statusCode, 200); assert.equal((await f.app.inject('/health/ready')).statusCode, 200);
    for (const x of held) { x.response.destroy(); x.request.destroy(); }
    for (let i = 0; i < 100; i++) { const r = await f.app.inject({ url: p.payloadUrl(), headers: { range: 'bytes=0-3' } }); if (r.statusCode === 206) break; assert.equal(r.statusCode, 503); await new Promise(done => setTimeout(done, 10)); }
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => f.app.inject({ url: i % 2 ? p.installerUrl : p.payloadUrl(), headers: { range: 'bytes=0-1023' } })));
    for (const r of results) { assert.equal(r.statusCode, 206, r.body); assert.deepEqual(r.rawPayload, large.subarray(0, 1024)); }
  } finally { for (const x of held) { x.response.destroy(); x.request.destroy(); } f.app.server.closeAllConnections(); }
});
