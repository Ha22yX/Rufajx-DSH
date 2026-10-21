import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { prepareClientRelease, digestFile } from '../scripts/prepare-client-release.mjs';

test('release stages the verified installer and blockmap without activating the feed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rufa-client-release-'));
  const installer = join(root, 'Rufa-DSH-0.2.0-x64-Setup.exe'), output = join(root, 'feed');
  const bytes = Buffer.from('MZ isolated installer fixture');
  await writeFile(installer, bytes); await writeFile(installer + '.blockmap', 'isolated blockmap fixture');
  const report = await prepareClientRelease({ installer, version: '0.2.0', output });
  const manifest = JSON.parse(await readFile(join(report.directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.files[0].sha512, createHash('sha512').update(bytes).digest('base64'));
  assert.equal(manifest.files[0].url, 'releases/0.2.0/Rufa-DSH-0.2.0-x64-Setup.exe');
  assert.equal(manifest.blockmap.sha512, (await digestFile(installer + '.blockmap')).sha512);
  assert.deepEqual(await readFile(join(report.directory, report.installer.file)), bytes);
  assert.equal(report.active, false); assert.ok(!(await readdir(output)).includes('current.json'));
  await assert.rejects(prepareClientRelease({ installer, version: '0.2.0', output }), /already exists/);
});

test('release rejects prereleases, path-like versions, and mismatching artifact version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rufa-release-invalid-'));
  const installer = join(root, 'Rufa-DSH-0.2.0-x64-Setup.exe'); await writeFile(installer, 'MZ fixture');
  for (const version of ['../0.2.0', '0.2.0-beta.1', '01.2.0', '0.3.0']) {
    await assert.rejects(prepareClientRelease({ installer, version, output: join(root, 'feed') }));
  }
});
