import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedPath, parseRelease, verifyManifest, safeLocalPath, matchesFile } from '../dist/incremental-update-protocol.js';
import { IncrementalUpdateController } from '../dist/incremental-update.js';

const keys = generateKeyPairSync('rsa', { modulusLength: 3072 });
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
const keyId = createHash('sha256').update(keys.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
const trust = { keyId, publicKey };
const entry = (path, bytes) => ({ path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), sha512: createHash('sha512').update(bytes).digest('base64') });
function release(files, modify = () => {}) {
  const manifest = { schema: 1, version: '0.3.1', platform: 'win32', arch: 'x64', releaseDate: '2026-10-21T00:00:00.000Z', minUpdaterVersion: '0.3.0', files };
  modify(manifest); const bytes = Buffer.from(JSON.stringify(manifest));
  const info = { schema: 1, version: manifest.version, releaseDate: manifest.releaseDate, minUpdaterVersion: manifest.minUpdaterVersion,
    manifest: { url: `releases/${manifest.version}/incremental-manifest.json`, size: bytes.length, sha512: createHash('sha512').update(bytes).digest('base64'), keyId, algorithm: 'rsa-sha256', signature: sign('RSA-SHA256', bytes, keys.privateKey).toString('base64') },
    installer: { url: `releases/${manifest.version}/Rufa-DSH-${manifest.version}-x64-Setup.exe`, size: 1, sha512: entry('x', Buffer.from('x')).sha512 } };
  return { info, bytes };
}
const required = [entry('Rufajx-DSH-App.exe', Buffer.from('app')), entry('resources/app.asar', Buffer.from('asar'))];
const until = async fn => { for (let n = 0; n < 500; n++) { if (fn()) return; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail('condition timeout'); };

test('signed manifest rejects changed bytes, wrong trust, conflicting paths and reserved maintenance files', () => {
  const good = release(required); assert.equal(verifyManifest(good.bytes, parseRelease(good.info), trust).version, '0.3.1');
  assert.throws(() => verifyManifest(Buffer.concat([good.bytes, Buffer.from(' ')]), good.info, trust));
  assert.throws(() => verifyManifest(good.bytes, good.info, { ...trust, keyId: 'a'.repeat(64) }));
  for (const path of ['../escape', 'C:/x', '/x', 'a\\b', 'NUL.txt', 'CONIN$.x', 'a/com¹.exe', 'a:stream', 'x.', 'a/ ', '.rufa-update/transaction', 'Rufajx-DSH.exe', 'Rufajx-DSH.exe.config', 'Uninstall Rufajx-DSH.exe', '\ud800']) assert.equal(managedPath(path), false, path);
  for (const additions of [[entry('RESOURCES/app.asar', Buffer.from('x'))], [entry('resources', Buffer.from('x'))], [entry('Rufajx-DSH.exe', Buffer.from('x'))]]) {
    const bad = release([...required, ...additions]); assert.throws(() => verifyManifest(bad.bytes, bad.info, trust));
  }
});
test('payload hashing detects content changes and junctions never become an update destination', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rufa-incremental-path-')), other = await mkdtemp(join(tmpdir(), 'rufa-outside-'));
  await writeFile(join(root, 'data'), 'abc'); assert.equal(await matchesFile(join(root, 'data'), entry('data', Buffer.from('abc')), new AbortController().signal), true);
  await writeFile(join(root, 'data'), 'abd'); assert.equal(await matchesFile(join(root, 'data'), entry('data', Buffer.from('abc')), new AbortController().signal), false);
  await symlink(other, join(root, 'linked'), 'junction'); await assert.rejects(safeLocalPath(root, 'linked/outside.txt'));
});
async function fixture(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'rufa-incremental-client-')); await mkdir(join(root, 'resources'));
  await writeFile(join(root, 'Rufajx-DSH-App.exe'), 'app'); await writeFile(join(root, 'resources/app.asar'), 'old!');
  const fresh = Buffer.from('new!'), { info, bytes } = release([required[0], entry('resources/app.asar', fresh)]);
  const calls = []; let handoff = 0, launched = 0, safe = true;
  const fetcher = async (url, options) => {
    calls.push(url); assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit'); assert.equal(options.headers, undefined);
    if (url.endsWith('/incremental/latest.json')) return Response.json(info);
    if (url.endsWith('/incremental-manifest.json')) return new Response(bytes);
    if (url.endsWith('/' + info.manifest.sha256)) assert.fail('manifest hash is not a blob');
    if (url.endsWith('/' + entry('x', fresh).sha256)) return new Response(fresh);
    assert.fail('unexpected endpoint: ' + url);
  };
  const controller = new IncrementalUpdateController({ root, currentVersion: '0.3.0', trust, canInstall: () => safe,
    onHandoff: () => handoff++, createFallback: () => assert.fail('unexpected full-installer fallback'), fetch: fetcher,
    launch: async (_root, signal, allowed) => { signal.throwIfAborted(); assert.equal(allowed(), true); launched++; }, ...overrides });
  return { root, controller, calls, info, get handoff() { return handoff; }, get launched() { return launched; }, unsafe() { safe = false; } };
}
test('client downloads only changed content, leaves installed bytes and identity untouched until native handoff', async () => {
  const f = await fixture(), before = await stat(join(f.root, 'Rufajx-DSH-App.exe')); f.controller.start(); await until(() => f.handoff === 1);
  assert.equal(f.calls.filter(url => url.includes('/payloads/')).length, 1); assert.equal(await readFile(join(f.root, 'resources/app.asar'), 'utf8'), 'old!');
  const after = await stat(join(f.root, 'Rufajx-DSH-App.exe')); assert.equal(before.ino, after.ino); assert.equal(before.mtimeMs, after.mtimeMs);
  assert.equal(JSON.parse(await readFile(join(f.root, '.rufa-update/pending.json'), 'utf8')).manifest.signature, f.info.manifest.signature);
  assert.equal(f.controller.blocking, true); f.controller.stop();
});
test('tampered blob remains a recoverable startup error and never reaches installation', async () => {
  const f = await fixture(); const original = f.controller.options.fetch;
  f.controller.options.fetch = (url, options) => url.includes('/payloads/') ? Promise.resolve(new Response('bad!')) : original(url, options);
  const gate = f.controller.start(); await until(() => f.controller.state.phase === 'error'); assert.equal(f.launched, 0);
  f.controller.continueCurrent(); assert.equal(await gate, true); assert.equal(await readFile(join(f.root, 'resources/app.asar'), 'utf8'), 'old!');
});
test('reentrant login admission at installing prevents handoff and late work after continue is inert', async () => {
  const f = await fixture(); f.controller.on('change', state => { if (state.phase === 'installing') f.unsafe(); });
  const gate = f.controller.start(); await until(() => f.controller.state.phase === 'error'); assert.equal(f.launched, 0);
  f.controller.continueCurrent(); assert.equal(await gate, true); f.controller.retry(); assert.equal(f.launched, 0);
});
test('server BUSY responses retry briefly and cancellation ends the wait without installation', async () => {
  const f=await fixture();const original=f.controller.options.fetch;let attempts=0;
  f.controller.options.fetch=(url,options)=>url.includes('/payloads/')&&attempts++===0?Promise.resolve(Response.json({error:{code:'CLIENT_RELEASE_BUSY'}},{status:503,headers:{'Retry-After':'0.01'}})):original(url,options);
  f.controller.start();await until(()=>f.handoff===1);assert.equal(attempts,2);f.controller.stop();
  const blocked=await fixture({fetch:async()=>Response.json({error:{code:'CLIENT_RELEASE_BUSY'}},{status:503,headers:{'Retry-After':'10'}})});
  const gate=blocked.controller.start();await new Promise(resolve=>setTimeout(resolve,20));blocked.controller.stop();assert.equal(await gate,false);assert.equal(blocked.launched,0);
});
test('a progressing slow payload is limited by idle time, not a 90 second overall deadline', async t => {
  const realTimeout=setTimeout;
  const realPause=()=>new Promise(resolve=>realTimeout(resolve,5));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f=await fixture(); const original=f.controller.options.fetch; let stream,signal;
  f.controller.options.fetch=(url,options)=>{
    if(!url.includes('/payloads/'))return original(url,options);
    signal=options.signal;return Promise.resolve(new Response(new ReadableStream({start(controller){stream=controller;}})));
  };
  const settle=async()=>{for(let i=0;i<4;i++)await realPause();};
  const waitFor=async predicate=>{for(let i=0;i<400;i++){if(predicate())return;await realPause();}assert.fail('stream fixture timeout: '+f.controller.state.phase);};
  f.controller.start();await waitFor(()=>!!stream);await settle();
  for(const char of 'new!'){t.mock.timers.tick(80_000);assert.equal(signal.aborted,false);stream.enqueue(Buffer.from(char));await settle();}
  stream.close();await waitFor(()=>f.handoff===1);f.controller.stop();
});
