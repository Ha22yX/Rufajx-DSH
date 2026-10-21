import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, link, symlink, rename, rm, realpath, access } from 'node:fs/promises';
import { join, dirname, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { auditRuntimeSlim, applyRuntimeSlim } from '../scripts/runtime-slim.mjs';
const runtime = process.env.RUFA_RUNTIME_ROOT;
const policy = JSON.parse(await readFile(new URL('../runtime-slim.lock.json', import.meta.url), 'utf8'));

async function fixture(t) {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'rufa-slim-test-'))), root = join(temporary, 'runtime');
  t.after(async () => {
    assert.equal(dirname(resolve(temporary)), await realpath(tmpdir())); assert.ok(basename(temporary).startsWith('rufa-slim-test-'));
    await rm(temporary, { recursive: true, force: true });
  });
  await mkdir(root);
  await writeFile(join(root, 'rufa-runtime.json'), JSON.stringify({ platform: policy.platform, upstreamCommit: policy.upstreamCommit }));
  for (const row of [...policy.removed, ...policy.retained]) {
    await mkdir(dirname(join(root, row.path)), { recursive: true });
    await copyFile(join(runtime, row.path), join(root, row.path));
  }
  await writeFile(join(root, 'must-keep.ts'), 'const keep: string = "source remains";');
  await writeFile(join(root, 'must-keep.js.map'), '{"debug":true}');
  return { root, temporary };
}

test('slim audit is read-only and exact ARM64 removal preserves every retained byte and hardlink peer', { skip: !runtime }, async t => {
  const { root, temporary } = await fixture(t), row = policy.removed[0], peer = join(temporary, 'hardlink-peer');
  await link(join(root, row.path), peer);
  const audit = await auditRuntimeSlim(root);
  assert.equal(audit.removableFiles, 6); assert.equal(audit.removableBytes, 11768384);
  await assert.rejects(access(join(root, 'rufa-runtime-slim.json')), { code: 'ENOENT' });
  for (const item of policy.removed) await access(join(root, item.path));
  const applied = await applyRuntimeSlim(root);
  assert.equal(applied.beforeBytes - applied.afterBytes, 11768384);
  assert.equal(applied.beforeFiles - applied.afterFiles, 6); assert.equal(applied.retainedFilesUnchanged, true);
  assert.equal(createHash('sha256').update(await readFile(peer)).digest('hex'), row.sha256);
  for (const item of policy.retained) assert.equal(createHash('sha256').update(await readFile(join(root, item.path))).digest('hex'), item.sha256);
  assert.equal(await readFile(join(root, 'must-keep.ts'), 'utf8'), 'const keep: string = "source remains";');
  assert.equal(await readFile(join(root, 'must-keep.js.map'), 'utf8'), '{"debug":true}');
  const second = await applyRuntimeSlim(root);
  assert.equal(second.changed, false); assert.equal(second.removableBytes, 0);
  assert.equal(second.validation, 'pinned-native-files'); assert.equal(second.retainedFilesUnchanged, undefined);
  assert.equal((await auditRuntimeSlim(root)).retainedSha256, audit.retainedSha256);
  const marker = JSON.parse(await readFile(join(root, 'rufa-runtime-slim.json'), 'utf8'));
  marker.state = 'prepared'; await writeFile(join(root, 'rufa-runtime-slim.json'), JSON.stringify(marker));
  assert.equal((await applyRuntimeSlim(root)).state, 'complete', 'interrupted prepared state can complete without deleting anything else');
});

test('wrong platform, altered allowlist file, unexplained missing file and invalid marker all fail before deletion', { skip: !runtime }, async t => {
  const { root } = await fixture(t), target = join(root, policy.removed[0].path), original = await readFile(target);
  const manifestPath = join(root, 'rufa-runtime.json'), manifest = await readFile(manifestPath);
  await writeFile(manifestPath, JSON.stringify({ upstreamCommit: policy.upstreamCommit, platform: 'win32-arm64' }));
  await assert.rejects(applyRuntimeSlim(root), /platform/); await writeFile(manifestPath, manifest);
  await writeFile(target, 'unexpected bytes'); await assert.rejects(applyRuntimeSlim(root), /Pinned slim file changed/);
  await writeFile(target, original);
  await rm(target); await assert.rejects(applyRuntimeSlim(root), { code: 'ENOENT' }); await writeFile(target, original);
  await writeFile(join(root, 'rufa-runtime-slim.json'), '{}'); await assert.rejects(applyRuntimeSlim(root), /marker/);
  for (const item of policy.removed) await access(join(root, item.path));
});

test('junctions cannot redirect candidate deletion to another directory', { skip: !runtime }, async t => {
  const { root, temporary } = await fixture(t), path = join(root, 'node_modules/node-pty/prebuilds/win32-arm64'), outside = join(temporary, 'outside');
  await rename(path, outside); await symlink(outside, path, 'junction');
  await assert.rejects(applyRuntimeSlim(root), /redirected/);
  for (const item of policy.removed) await access(join(outside, item.path.split('win32-arm64/')[1]));
  await assert.rejects(access(join(root, 'rufa-runtime-slim.json')), { code: 'ENOENT' });
});
