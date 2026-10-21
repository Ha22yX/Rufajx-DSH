import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, cp, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, basename, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { initializeDesktopVideoDefaults, computerUseBundle, remotionSkillBundle, computerUseDefaults, computerUseTools } from '../dist/desktop-video-defaults.js';
import { createRemotionProvider, remotionSkillName } from '../preinstalled/bundles/remotion/provider.mjs';
import { computerUseContext } from '../src/runtime/computer-use-context.mjs';

const runtime = process.env.RUFA_RUNTIME_ROOT, wincu = process.env.RUFA_WINCU_SOURCE;
const needsRuntime = { skip: !runtime || !wincu };
const bundleNames = [computerUseBundle, remotionSkillBundle];
async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'rufa-desktop-video-test-'));
  t.after(async () => { assert.equal(dirname(root), tmpdir()); assert(basename(root).startsWith('rufa-desktop-video-test-')); await rm(root, { recursive: true, force: true }); });
  return root;
}
async function fixture(t) {
  const root = await temporary(t), shadow = join(root, 'runtime'), home = join(root, 'account-a');
  await mkdir(join(shadow, 'node_modules'), { recursive: true });
  await cp(join(runtime, 'package.json'), join(shadow, 'package.json'));
  for (const name of ['yaml', '@deepseek-ai/dsh-app-boot', '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']) {
    const target = join(shadow, 'node_modules', name); await mkdir(dirname(target), { recursive: true });
    await symlink(await realpath(join(runtime, 'node_modules', name)), target, 'junction');
  }
  const upstream = join(shadow, 'node_modules', computerUseBundle); await mkdir(upstream, { recursive: true });
  for (const file of ['package.json', 'cordis.patch.yml']) await cp(join(wincu, file), join(upstream, file));
  await cp(fileURLToPath(new URL('../preinstalled/bundles/remotion/', import.meta.url)), join(shadow, 'node_modules', remotionSkillBundle), { recursive: true });
  const directory = join(home, 'profiles/web'); await mkdir(directory, { recursive: true });
  const manifestFile = join(directory, 'package.json'), patchFile = join(directory, 'cordis.patch.yml');
  const manifest = { name: 'synthetic-account', private: true, future: 'keep', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], future: 'keep' } } };
  await writeFile(manifestFile, JSON.stringify(manifest)); await writeFile(patchFile, '[]\n');
  const yaml = createRequire(join(shadow, 'package.json'))('yaml');
  return { root, shadow, home, directory, manifestFile, patchFile, manifest, yaml,
    rows: async () => yaml.parse(await readFile(patchFile, 'utf8'), { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] }) };
}

test('computer defaults match pinned 0.4.3 settings and reserve Esc without activating desktop input', needsRuntime, async () => {
  const { normalizeSettings, TOOL_NAMES } = await import(pathToFileURL(join(wincu, 'mcp/settings.mjs')).href);
  assert.deepEqual(computerUseTools, TOOL_NAMES); assert.equal(computerUseTools.length, 24);
  const normalized = normalizeSettings(computerUseDefaults);
  assert.equal(normalized.toolPreset, 'full'); assert.equal(normalized.indicatorText, 'Rufa智能体正在控制电脑');
  assert.equal(normalized.indicatorEnabled, true); assert.equal(normalized.cursorIndicatorEnabled, false);
  assert.equal(normalized.remoteIndicatorVisible, true); assert.equal(normalized.indicatorPosition, 'top');
  assert.equal(normalized.indicatorIdleMs, 800); assert.equal(normalized.stopShortcut, '');
  assert.equal(normalized.previewToken, 0); assert.equal(normalized.resumeToken, 0);
});

test('new account independently enables both native bundles and adds exactly the configured defaults', needsRuntime, async t => {
  const f = await fixture(t); await initializeDesktopVideoDefaults(f.home, f.shadow);
  const manifest = JSON.parse(await readFile(f.manifestFile, 'utf8'));
  assert.deepEqual(manifest.dsh.profile.bundles, [...f.manifest.dsh.profile.bundles, ...bundleNames]);
  assert.equal(manifest.future, 'keep'); assert.equal(manifest.dsh.profile.future, 'keep');
  assert.deepEqual((await f.rows())[0], { id: 'mcp-dsh-computer-use-win', config: computerUseDefaults });
  for (const name of ['.rufa-computer-use-defaults-v1', '.rufa-remotion-defaults-v1']) assert.equal((await readFile(join(f.directory, name), 'utf8')).trim(), '1');
  for (const name of ['.rufa-office-defaults-v1', '.rufa-admin-preset-v1.json']) await assert.rejects(readFile(join(f.directory, name)), { code: 'ENOENT' });
});

test('existing comments, dynamic unrelated rows and explicit computer settings survive migration', needsRuntime, async t => {
  const f = await fixture(t);
  await writeFile(f.patchFile, '# keep comment\n- id: unrelated\n  disabled: !!js "true"\n- id: mcp-dsh-computer-use-win\n  disabled: true\n  config:\n    indicatorText: My text\n    cursorIndicatorEnabled: true\n    enabledTools: [screenshot]\n    toolPreset: custom\n    future: 7\n');
  await initializeDesktopVideoDefaults(f.home, f.shadow);
  const source = await readFile(f.patchFile, 'utf8'), rows = await f.rows(), row = rows.find(row => row.id === 'mcp-dsh-computer-use-win');
  assert(source.includes('# keep comment')); assert(source.includes('!!js')); assert.equal(row.disabled, true);
  assert.equal(row.config.indicatorText, 'My text'); assert.equal(row.config.cursorIndicatorEnabled, true);
  assert.equal(row.config.toolPreset, 'custom'); assert.deepEqual(row.config.enabledTools, ['screenshot']);
  assert.equal(row.config.future, 7); assert.equal(row.config.indicatorIdleMs, 800);
});

test('later disabling either bundle and changing settings is byte-preserved across repeated startup', needsRuntime, async t => {
  const f = await fixture(t); await initializeDesktopVideoDefaults(f.home, f.shadow);
  let manifest = JSON.parse(await readFile(f.manifestFile, 'utf8'));
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(name => name !== computerUseBundle);
  await writeFile(f.manifestFile, JSON.stringify(manifest)); const custom = '# later preference\n- id: mcp-dsh-computer-use-win\n  config: { indicatorIdleMs: 1200 }\n'; await writeFile(f.patchFile, custom);
  await initializeDesktopVideoDefaults(f.home, f.shadow);
  assert.deepEqual(JSON.parse(await readFile(f.manifestFile, 'utf8')), manifest); assert.equal(await readFile(f.patchFile, 'utf8'), custom);
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(name => name !== remotionSkillBundle); await writeFile(f.manifestFile, JSON.stringify(manifest));
  await initializeDesktopVideoDefaults(f.home, f.shadow);
  assert.deepEqual(JSON.parse(await readFile(f.manifestFile, 'utf8')), manifest);
});

test('separate account markers and concurrent migration never leak or duplicate defaults', needsRuntime, async t => {
  const f = await fixture(t); await Promise.all([initializeDesktopVideoDefaults(f.home, f.shadow), initializeDesktopVideoDefaults(f.home, f.shadow)]);
  const other = join(f.root, 'account-b'), directory = join(other, 'profiles/web'); await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'package.json'), JSON.stringify(f.manifest)); await writeFile(join(directory, 'cordis.patch.yml'), '[]\n');
  await initializeDesktopVideoDefaults(other, f.shadow);
  assert.equal((await f.rows()).filter(row => row.id === 'mcp-dsh-computer-use-win').length, 1);
  assert(JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')).dsh.profile.bundles.includes(remotionSkillBundle));
});

test('missing or incompatible shipped package fails before account edits and can retry', needsRuntime, async t => {
  const f = await fixture(t), packageFile = join(f.shadow, 'node_modules', computerUseBundle, 'package.json');
  const original = await readFile(packageFile, 'utf8'), source = await readFile(f.manifestFile, 'utf8');
  await writeFile(packageFile, original.replace('"version": "0.4.3"', '"version": "0.5.0"'));
  await assert.rejects(initializeDesktopVideoDefaults(f.home, f.shadow), /0.4.3/);
  assert.equal(await readFile(f.manifestFile, 'utf8'), source); assert.equal(await readFile(f.patchFile, 'utf8'), '[]\n');
  await assert.rejects(readFile(join(f.directory, '.rufa-computer-use-defaults-v1')), { code: 'ENOENT' });
  await writeFile(packageFile, original); await initializeDesktopVideoDefaults(f.home, f.shadow);
});

test('invalid or ambiguous user configuration remains untouched without committing markers', needsRuntime, async t => {
  const f = await fixture(t);
  for (const source of ['invalid: map\n', '- id: mcp-dsh-computer-use-win\n- id: mcp-dsh-computer-use-win\n', '- id: mcp-dsh-computer-use-win\n  config: !!js "doNotExecute()"\n']) {
    await writeFile(f.patchFile, source); await assert.rejects(initializeDesktopVideoDefaults(f.home, f.shadow));
    assert.equal(await readFile(f.patchFile, 'utf8'), source);
    await assert.rejects(readFile(join(f.directory, '.rufa-computer-use-defaults-v1')), { code: 'ENOENT' });
  }
});

test('Remotion discovery has routing metadata only and loads the current complete body on demand', async t => {
  const root = await temporary(t), directory = join(root, 'company-tools/remotion', remotionSkillName), file = join(directory, 'SKILL.md');
  await mkdir(directory, { recursive: true }); await writeFile(file, '---\nname: remotion-motion-graphics\n---\nold full body');
  const provider = createRemotionProvider({ runtimeRoot: root, rank: 600, node: 'C:/synthetic/node.exe' });
  const candidates = await provider.list(); assert.equal(candidates.length, 1); assert.equal(candidates[0].content, undefined);
  assert.match(candidates[0].description, /先加载/); assert.equal(candidates[0].resourceBase.path, directory.replaceAll('\\', '/'));
  await writeFile(file, '---\nname: remotion-motion-graphics\n---\nComplete workflow\nreferences/design-rules.md\nMANDATORY visual verification');
  const loaded = await provider.get(candidates[0]); assert(loaded.content.includes('Complete workflow')); assert(loaded.content.includes('MANDATORY visual verification'));
  assert(loaded.content.includes('runner.mjs')); assert(loaded.content.includes('"compositions"')); assert(loaded.content.includes('--overwrite'));
  assert.equal(loaded.rank, undefined); assert.equal(loaded.locator, undefined);
  await assert.rejects(provider.get({ ...candidates[0], locator: join(root, 'secret') }), /无效/);
});

test('Remotion missing, malformed or cancelled resource reads fail instead of inventing skill content', async t => {
  const root = await temporary(t), provider = createRemotionProvider({ runtimeRoot: root, rank: 600 });
  await assert.rejects(provider.list(), { code: 'ENOENT' });
  const directory = join(root, 'company-tools/remotion', remotionSkillName); await mkdir(directory, { recursive: true }); await writeFile(join(directory, 'SKILL.md'), 'not a skill');
  const [candidate] = await provider.list(); await assert.rejects(provider.get(candidate), /格式/);
  const controller = new AbortController(); controller.abort(); await assert.rejects(provider.get(candidate, { signal: controller.signal }), { name: 'AbortError' });
});

test('desktop hint follows the current agent tool visibility and never loads the Remotion body', () => {
  const contexts = computerUseContext([{ name: 'mcp__wincu__windows_computer_use_click' }]); assert.equal(contexts.length, 1);
  assert.match(contexts[0].text, /逐工具审查/); assert(!contexts[0].text.includes('Remotion Motion Graphics'));
  assert.deepEqual(computerUseContext([]), []); assert.deepEqual(computerUseContext(), []);
});
