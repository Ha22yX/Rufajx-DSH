// Read-only public release verification; never starts the downloaded installer.
import assert from 'node:assert/strict';
import { readFile, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { verifyUpdateSignature } from './client-update-signing.mjs';

const feed = 'https://dsh.example.com/api/v1/client-updates/windows/x64/';
export async function verifyPublicClientRelease(directory) {
  directory = resolve(directory);
  const expected = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  const response = await fetch(feed + 'latest.yml', { signal: AbortSignal.timeout(30000), redirect: 'error' });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  const actual = await response.json();
  assert.deepEqual(actual.files, expected.files);
  for (const key of ['version', 'releaseDate', 'path', 'sha512']) assert.equal(actual[key], expected[key]);
  const file = expected.files[0];
  assert.equal(file.url, `releases/${expected.version}/Rufa-DSH-${expected.version}-x64-Setup.exe`);
  const url = new URL(file.url, feed).href;
  const head = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(30000), redirect: 'error' });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers.get('content-length')), file.size);
  assert.equal(head.headers.get('accept-ranges'), 'bytes');
  const handle = await open(join(directory, `Rufa-DSH-${expected.version}-x64-Setup.exe`), 'r');
  try {
    for (const start of [0, Math.max(0, file.size - 64)]) {
      const end = Math.min(file.size - 1, start + 63), length = end - start + 1;
      const result = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal: AbortSignal.timeout(30000), redirect: 'error' });
      assert.equal(result.status, 206);
      assert.equal(result.headers.get('content-range'), `bytes ${start}-${end}/${file.size}`);
      const local = Buffer.alloc(length);
      assert.equal((await handle.read(local, 0, length, start)).bytesRead, length);
      assert.deepEqual(Buffer.from(await result.arrayBuffer()), local);
    }
  } finally { await handle.close(); }
  const invalid = await fetch(url, { headers: { Range: `bytes=${file.size}-` }, signal: AbortSignal.timeout(30000), redirect: 'error' });
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get('content-range'), `bytes */${file.size}`);
  await invalid.body?.cancel();
  let incremental;
  if (expected.incremental) {
    const latest = await fetch(feed + 'incremental/latest.json', { signal: AbortSignal.timeout(30000), redirect: 'error' });
    assert.equal(latest.status, 200);
    assert.match(latest.headers.get('cache-control') ?? '', /no-store/);
    const envelope = await latest.json();
    assert.equal(envelope.version, expected.version);
    assert.deepEqual(envelope.manifest, expected.incremental);
    assert.deepEqual(envelope.installer, file);
    const rawResponse = await fetch(new URL(envelope.manifest.url, feed), { signal: AbortSignal.timeout(30000), redirect: 'error' });
    assert.equal(rawResponse.status, 200);
    const raw = Buffer.from(await rawResponse.arrayBuffer());
    assert.deepEqual(raw, await readFile(join(directory, 'incremental-manifest.json')));
    assert.equal(createHash('sha512').update(raw).digest('base64'), envelope.manifest.sha512);
    const publicKey = await readFile(new URL('../infra/client-update-public.pem', import.meta.url), 'utf8');
    assert.ok(verifyUpdateSignature(raw, envelope.manifest, publicKey));
    const inventory = JSON.parse(raw);
    const samples = [...new Map([inventory.files[0], inventory.files.at(-1),
      inventory.files.find(f => f.path === 'resources/app.asar'), inventory.files.find(f => f.size === 0)]
      .filter(Boolean).map(f => [f.sha256, f])).values()];
    for (const sample of samples) {
      const objectUrl = new URL(`releases/${expected.version}/payloads/${sample.sha256}`, feed);
      const object = await fetch(objectUrl, { signal: AbortSignal.timeout(120000), redirect: 'error' });
      assert.equal(object.status, 200);
      const bytes = Buffer.from(await object.arrayBuffer());
      assert.equal(bytes.length, sample.size);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), sample.sha256);
      assert.equal(createHash('sha512').update(bytes).digest('base64'), sample.sha512);
      const ranged = await fetch(objectUrl, { headers: { Range: 'bytes=0-31' }, signal: AbortSignal.timeout(30000), redirect: 'error' });
      assert.equal(ranged.status, sample.size ? 206 : 416);
      if (sample.size) assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), bytes.subarray(0, 32));
      else await ranged.body?.cancel();
    }
    incremental = { signatureVerified: true, fileCount: inventory.files.length, sampledObjects: samples.length, rawBytesMatch: true };
  }
  return { version: expected.version, size: file.size, url, metadata: true, rangeBytesMatch: true, invalidRangeRejected: true, incremental };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (!process.argv[2]) throw new Error('Usage: verify-public-client-release.mjs <prepared releases/X.Y.Z directory>');
  console.log(JSON.stringify(await verifyPublicClientRelease(process.argv[2]), null, 2));
}
