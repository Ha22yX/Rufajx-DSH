import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { mkdtemp, mkdir, writeFile, readFile, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rebrandDictionarySource, brandRuntime } from '../scripts/brand-runtime.mjs';

test('runtime branding changes static UI copy without changing identifiers or message processing', () => {
  const source = `const copy = {'brand.localBuild': 'DSH 本地构建', title: 'DSH Local Build', help: 'DeepSeek Harness uses DSH {version}', env: 'DSH_HOME'}; const message = 'DSH'; const getUserText = text => text; const id = '@deepseek-ai/dsh-client-ui';`;
  const result = rebrandDictionarySource(source, ts);
  assert.equal(result.replacements, 3);
  assert.ok(result.source.includes('"Rufajx-DSH"'));
  assert.ok(result.source.includes('"Rufajx-DSH uses Rufajx-DSH {version}"'));
  assert.ok(result.source.includes("env: 'DSH_HOME'"));
  assert.ok(result.source.includes("const message = 'DSH'; const getUserText = text => text; const id = '@deepseek-ai/dsh-client-ui'"));
  const repeated = rebrandDictionarySource(result.source, ts);
  assert.equal(repeated.replacements, 0);
  assert.equal(repeated.source, result.source);
});

test('runtime customization preserves hardlinked upstream artifacts', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'rufa-branding-'));
  try {
    const runtime = join(temporary, 'runtime');
    const artifact = join(runtime, 'node_modules', '@deepseek-ai', 'dsh-client-copy', 'lib', 'client.js');
    await mkdir(dirname(artifact), { recursive: true });
    await writeFile(join(runtime, 'rufa-runtime.json'), JSON.stringify({ upstreamCommit: '687f282e8625c6b8d11ff58211a90524be2e4317' }));
    const original = join(temporary, 'upstream-client.js');
    const source = "const translations = {title:'DSH 本地构建'};";
    await writeFile(original, source);
    await link(original, artifact);
    const workspace = fileURLToPath(new URL('../', import.meta.url));
    assert.equal((await brandRuntime(runtime, workspace)).changed.length, 1);
    assert.equal(await readFile(original, 'utf8'), source);
    assert.ok((await readFile(artifact, 'utf8')).includes('Rufajx-DSH'));
    assert.deepEqual((await brandRuntime(runtime, workspace)).changed, []);
  } finally {
    assert.equal(dirname(resolve(temporary)), resolve(tmpdir()));
    assert.ok(basename(temporary).startsWith('rufa-branding-'));
    await rm(temporary, { recursive: true, force: true });
  }
});
