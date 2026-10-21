import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, link, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { badgeBundle, badgeTitle, skillDescription, patchBadgeRuntime } from '../scripts/badge-runtime.mjs';

const originalDescription = 'Add the official “powered by dsh” badge to documents, pull requests, merge requests, and other content produced with DeepSeek Harness. Use whenever creating a pull request or merge request. Also use when the user asks for a dsh badge, powered-by-dsh attribution, or a reusable dsh badge asset or snippet.';
async function fixture(t) {
  const temporary = await mkdtemp(join(tmpdir(), 'rufa-badge-patch-'));
  t.after(async () => {
    assert.equal(dirname(resolve(temporary)), resolve(tmpdir()));
    await rm(temporary, { recursive: true, force: true });
  });
  const runtime = join(temporary, 'runtime');
  await mkdir(runtime);
  await writeFile(join(runtime, 'rufa-runtime.json'), JSON.stringify({ upstreamCommit: '687f282e8625c6b8d11ff58211a90524be2e4317' }));
  for (const name of [badgeBundle, '@deepseek-ai/dsh-skill-badge']) {
    const base = join(runtime, 'node_modules', name);
    await mkdir(join(base, 'locale'), { recursive: true });
    await mkdir(join(base, 'assets')); await mkdir(join(base, 'lib'));
    await writeFile(join(base, 'package.json'), JSON.stringify({ name, version: '0.2.1-rc.2', license: 'MIT', description: 'upstream', repository: { url: 'upstream-repository' } }));
    for (const language of ['en', 'zh']) await writeFile(join(base, 'locale', `${language}.json`), JSON.stringify({ meta: { title: 'DSH', description: 'old badge' }, retained: 'unrelated' }));
  }
  const provider = join(runtime, 'node_modules/@deepseek-ai/dsh-skill-badge/lib/index.js');
  const original = join(temporary, 'immutable-upstream.js');
  const source = `const CANDIDATE = {name: 'dsh-badge', description: ${JSON.stringify(originalDescription)}};\nfunction apply(ctx) { ctx.skills.registerProvider(() => provider); }`;
  await writeFile(original, source); await link(original, provider);
  const ui = join(runtime, 'node_modules/@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js');
  await mkdir(dirname(ui), { recursive: true });
  await writeFile(ui, 'var badge_skill_preview_default = "data:image/svg+xml;base64,PHN2Zy8+";\nvar badge_skill_preview_zh_default = "data:image/svg+xml;base64,PHN2Zy8+";\nconst other = "unchanged";');
  return { runtime, original, source, provider, ui };
}

test('company badge replaces skill, assets and both previews without touching immutable upstream or plugin identity', async t => {
  const { runtime, original, source, provider, ui } = await fixture(t);
  const result = await patchBadgeRuntime(runtime);
  assert.ok(result.changed.length > 10);
  assert.equal(await readFile(original, 'utf8'), source, 'hardlinked source is unchanged');
  assert.ok((await readFile(provider, 'utf8')).includes(skillDescription));
  assert.ok((await readFile(provider, 'utf8')).includes("name: 'dsh-badge'"));
  for (const name of [badgeBundle, '@deepseek-ai/dsh-skill-badge']) {
    const path = join(runtime, 'node_modules', name);
    const pkg = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
    assert.equal(pkg.name, name); assert.equal(pkg.version, '0.2.1-rc.2'); assert.equal(pkg.license, 'MIT');
    assert.equal(pkg.repository.url, 'upstream-repository');
    for (const language of ['en', 'zh']) {
      const locale = JSON.parse(await readFile(join(path, 'locale', `${language}.json`), 'utf8'));
      assert.equal(locale.meta.title, badgeTitle); assert.equal(locale.retained, 'unrelated');
    }
  }
  const assets = join(runtime, 'node_modules/@deepseek-ai/dsh-skill-badge/assets');
  const body = await readFile(join(assets, 'dsh-badge.md'), 'utf8');
  assert.match(body, /如发机械有限公司/); assert.doesNotMatch(body, /powered.by.dsh|shields\.io|github\.com\/deepseek/);
  const png = await readFile(join(assets, 'rufa-badge.png'));
  assert.equal(png.readUInt32BE(16), 1080); assert.equal(png.readUInt32BE(20), 168);
  assert.deepEqual(png, await readFile(join(assets, 'dsh-badge.png')));
  const previews = [...(await readFile(ui, 'utf8')).matchAll(/"data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)"/g)];
  assert.equal(previews.length, 2);
  assert.ok(previews.every(match => Buffer.from(match[1], 'base64').toString().includes(png.toString('base64'))));
  assert.deepEqual(await patchBadgeRuntime(runtime), { changed: [] }, 'replay must not rewrite existing files');
});

test('changed native anchors fail before modifying any package', async t => {
  const { runtime, ui } = await fixture(t);
  const file = join(runtime, 'node_modules', badgeBundle, 'package.json');
  const before = await readFile(file, 'utf8');
  await writeFile(ui, 'new unsupported upstream build');
  await assert.rejects(patchBadgeRuntime(runtime), /Unsupported badge preview anchor/);
  assert.equal(await readFile(file, 'utf8'), before);
});

test('real native skill registry loads company content and removes the skill when disabled', { skip: !process.env.RUFA_BADGE_TEST_RUNTIME }, async () => {
  const root = await realpath(process.env.RUFA_BADGE_TEST_RUNTIME);
  const suffix = relative(await realpath(tmpdir()), root);
  assert.ok(suffix && !suffix.startsWith('..') && !isAbsolute(suffix), 'native integration requires an isolated temporary runtime');
  await patchBadgeRuntime(root);
  const require = createRequire(join(root, 'package.json'));
  const load = name => import(pathToFileURL(require.resolve(name)).href);
  const { Context } = await load('@deepseek-ai/cordis');
  const { default: SkillRegistry } = await load('@deepseek-ai/dsh-skill');
  const SkillBadge = await load('@deepseek-ai/dsh-skill-badge');
  const ctx = new Context();
  const registry = await ctx.plugin(SkillRegistry);
  let fiber;
  try {
    fiber = await ctx.plugin(SkillBadge);
    const skills = await ctx.skills.list();
    assert.equal(skills.length, 1); assert.equal(skills[0].name, 'dsh-badge');
    assert.equal(skills[0].description, skillDescription);
    assert.deepEqual(skills[0].invocation, { modelInvocable: true, userInvocable: true });
    const loaded = await ctx.skills.get('dsh-badge');
    assert.match(loaded.content, /如发机械有限公司/);
    assert.doesNotMatch(loaded.content, /powered.by.dsh|shields\.io/);
    assert.ok((await readFile(join(loaded.resourceBase.path, 'rufa-badge.png'))).length > 100);
    await fiber.dispose();
    assert.deepEqual(await ctx.skills.list(), []);
  } finally { await fiber?.dispose(); await registry.dispose(); }
});
