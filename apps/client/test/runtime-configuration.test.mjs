import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm, symlink, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonicalRuntimePaths, initializeProfileDefaults } from '../dist/runtime-configuration.js';

async function temporaryHome(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith(prefix));
    await rm(root, { recursive: true, force: true });
  });
  if (prefix.startsWith('rufa-profile-')) await fixtureBundles(root);
  return root;
}
const autoReview = '@deepseek-ai/dsh-experimental-auto-review';
const defaults = ['@deepseek-ai/dsh-experimental-cot-translation-bundle', '@deepseek-ai/dsh-experimental-session-search', '@deepseek-ai/dsh-experimental-session-titles-bundle'];
const office = ['@rufa/dsh-office-bundle', '@rufa/dsh-read-pdf-bundle', 'dsh-file-upload-ocr-plugin'];
const sidebar = 'dsh-better-sidebar';
const media = ['dsh-video-preview', '@huanlin/dsh-plugin-better-sidebar-plugin-audio'];
const agentTeam = '@deepseek-ai/dsh-experimental-agent-team-profile';
const badgeSkill = '@deepseek-ai/dsh-experimental-badge-skill-bundle';
async function fixtureBundles(home) {
  for (const [folder, name] of [['office', 'dsh-office-bundle'], ['read-pdf', 'dsh-read-pdf-bundle']]) {
    await cp(fileURLToPath(new URL(`../preinstalled/bundles/${folder}`, import.meta.url)), join(home, 'profiles/web/node_modules/@rufa', name), { recursive: true });
  }
  // Only the profile parser runs here. The real community package/UI is checked
  // separately by the integrated runtime; this fixture never executes a plugin.
  const directory = join(home, 'profiles/web/node_modules/dsh-file-upload-ocr-plugin');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'dsh-file-upload-ocr-plugin', version: '2.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }));
  await writeFile(join(directory, 'cordis.patch.yml'), '- insert:\n    - id: file-upload-ocr\n      name: dsh-file-upload-ocr-plugin\n');
  await fixtureSidebar(home);
  await fixtureMediaPreview(home);
}
async function fixtureMediaPreview(home, names = media) {
  for (const name of names) {
    const directory = join(home, 'profiles/web/node_modules', name);
    const video = name === media[0], id = video ? 'video-preview' : 'better-sidebar-audio';
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version: video ? '0.1.4' : '0.1.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }));
    await writeFile(join(directory, 'cordis.patch.yml'), `- insert:\n    - id: ${id}\n      name: ${JSON.stringify(name)}\n`);
  }
}
async function fixtureSidebar(home) {
  const directory = join(home, 'profiles/web/node_modules', sidebar);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: sidebar, version: '0.28.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }));
  await writeFile(join(directory, 'cordis.patch.yml'), '- insert:\n    - id: better-sidebar\n      name: dsh-better-sidebar\n');
}
async function runtimeWithoutPreinstalled(root, withAgentTeam = true, withBadgeSkill = true) {
  const shadow = join(root, 'runtime');
  await mkdir(join(shadow, 'node_modules'), { recursive: true });
  await cp(join(runtime, 'package.json'), join(shadow, 'package.json'));
  for (const name of ['yaml', '@deepseek-ai/dsh-app-boot', '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', autoReview, ...defaults, ...withAgentTeam ? [agentTeam] : [], ...withBadgeSkill ? [badgeSkill] : []]) {
    const destination = join(shadow, 'node_modules', name);
    await mkdir(dirname(destination), { recursive: true });
    await symlink(await realpath(join(runtime, 'node_modules', name)), destination, 'junction');
  }
  return shadow;
}

test('runtime executable, plugin and home aliases resolve to the same native paths', async t => {
  const root = await temporaryHome(t, 'rufa-canonical-test-');
  const real = join(root, 'actual'); await mkdir(real); await writeFile(join(real, 'node.exe'), 'fixture-only');
  const alias = join(root, 'alias'); await symlink(real, alias, 'junction');
  const result = await canonicalRuntimePaths({ runtimeRoot: alias, pluginRoot: alias, execPath: join(alias, 'node.exe'), userRoot: join(alias, 'accounts') });
  assert.equal(result.runtimeRoot, await realpath(real)); assert.equal(result.pluginRoot, result.runtimeRoot);
  assert.equal(result.execPath, await realpath(join(real, 'node.exe'))); assert.equal(result.userRoot, await realpath(join(real, 'accounts')));
});
const runtime = process.env.RUFA_RUNTIME_ROOT;
test('first-run defaults preserve saved YAML preferences and reset-to-default choices across restart', { skip: !runtime }, async t => {
  const root = await temporaryHome(t, 'rufa-profile-defaults-');
  const directory = join(root, 'profiles/web'), file = join(directory, 'cordis.patch.yml'); await mkdir(directory, { recursive: true });
  await writeFile(file, '# Keep my preferences\n- id: ui-theme\n  config: { preference: light, fontSize: 15 }\n- id: optional\n  disabled: !!js "true"\n- id: ui-settings-models\n  config: { credentialOnboarding: true, futurePreference: 4 }\n');
  const yaml = createRequire(join(runtime, 'package.json'))('yaml');
  const read = async () => yaml.parse(await readFile(file, 'utf8'), { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] });
  await initializeProfileDefaults(root, runtime, 'approved');
  let rows = await read();
  assert.equal(rows.find(row => row.id === 'ui-theme').config.preference, 'light');
  assert.equal(rows.find(row => row.id === 'agent-default-model').config.model, 'approved');
  assert.deepEqual(rows.find(row => row.id === 'ui-settings-models').config, { credentialOnboarding: true, futurePreference: 4 });
  assert.ok((await readFile(file, 'utf8')).includes('# Keep my preferences'));
  assert.ok((await readFile(file, 'utf8')).includes('!!js'));
  await writeFile(file, yaml.stringify(rows.filter(row => row.id !== 'ui-theme')));
  await initializeProfileDefaults(root, runtime, 'different'); rows = await read();
  assert.equal(rows.some(row => row.id === 'ui-theme'), false); assert.equal(rows.find(row => row.id === 'agent-default-model').config.model, 'approved');
  await writeFile(file, 'not: a sequence');
  await assert.rejects(initializeProfileDefaults(root, runtime, 'approved')); assert.equal(await readFile(file, 'utf8'), 'not: a sequence');
});

test('new profiles keep the native web bundles and enable review plus Bing/Auto, search and rolling titles', { skip: !runtime }, async t => {
  const root = await temporaryHome(t, 'rufa-profile-features-');
  const directory = join(root, 'profiles/web'), manifestFile = join(directory, 'package.json'), patchFile = join(directory, 'cordis.patch.yml');
  await initializeProfileDefaults(root, runtime, 'approved');
  const manifestText = await readFile(manifestFile, 'utf8'), patchText = await readFile(patchFile, 'utf8');
  const manifest = JSON.parse(manifestText);
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', autoReview, ...defaults, ...office, sidebar, ...media, agentTeam, badgeSkill]);
  const yaml = createRequire(join(runtime, 'package.json'))('yaml');
  const rows = yaml.parse(patchText);
  assert.deepEqual(rows.find(row => row.id === 'cot-translation').config, { provider: 'bing', targetLanguage: 'auto' });
  assert.equal((await readFile(join(directory, '.rufa-feature-defaults-v1'), 'utf8')).trim(), '1');
  assert.equal((await readFile(join(directory, '.rufa-office-defaults-v1'), 'utf8')).trim(), '1');
  assert.equal((await readFile(join(directory, '.rufa-better-sidebar-defaults-v1'), 'utf8')).trim(), '1');
  assert.equal((await readFile(join(directory, '.rufa-media-preview-defaults-v1'), 'utf8')).trim(), '1');
  assert.equal((await readFile(join(directory, '.rufa-agent-team-defaults-v1'), 'utf8')).trim(), '1');
  assert.equal((await readFile(join(directory, '.rufa-badge-skill-defaults-v1'), 'utf8')).trim(), '1');
  await initializeProfileDefaults(root, runtime, 'different');
  assert.equal(await readFile(manifestFile, 'utf8'), manifestText);
  assert.equal(await readFile(patchFile, 'utf8'), patchText);
});

test('existing profiles migrate defaults once, preserve user settings, and only mandatory review re-enables later', { skip: !runtime }, async t => {
  const root = await temporaryHome(t, 'rufa-profile-upgrade-');
  const directory = join(root, 'profiles/web'); await mkdir(directory, { recursive: true });
  const manifestFile = join(directory, 'package.json'), patchFile = join(directory, 'cordis.patch.yml');
  const oldManifest = { name: 'existing-company-profile', private: true, description: 'preserved metadata', dependencies: {},
    dsh: { extra: { preserved: true }, profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], futurePreference: 'keep' } } };
  await writeFile(manifestFile, JSON.stringify(oldManifest));
  const originalPatch = '# Preserve explicit translation preferences\n- id: cot-translation\n  config: { provider: google, targetLanguage: fr, futurePreference: 4 }\n- id: unrelated\n  disabled: !!js "true"\n';
  await writeFile(patchFile, originalPatch);
  await writeFile(join(directory, '.rufa-defaults-v1'), '1\n');
  await initializeProfileDefaults(root, runtime, 'approved');
  const upgraded = JSON.parse(await readFile(manifestFile, 'utf8'));
  assert.deepEqual(upgraded, { ...oldManifest, dsh: { ...oldManifest.dsh, profile: { ...oldManifest.dsh.profile, bundles: [...oldManifest.dsh.profile.bundles, autoReview, ...defaults, ...office, sidebar, ...media, agentTeam, badgeSkill] } } });
  assert.equal(await readFile(patchFile, 'utf8'), originalPatch);

  // A later user disable removes the optional bundles. Only mandatory review returns.
  const disabled = { ...upgraded, dsh: { ...upgraded.dsh, profile: { ...upgraded.dsh.profile, bundles: oldManifest.dsh.profile.bundles } } };
  await writeFile(manifestFile, JSON.stringify(disabled));
  const changedPatch = '# Later preferences remain editable\n- id: cot-translation\n  disabled: true\n  config: { provider: google, targetLanguage: de }\n';
  await writeFile(patchFile, changedPatch);
  await initializeProfileDefaults(root, runtime, 'different');
  const restarted = JSON.parse(await readFile(manifestFile, 'utf8'));
  assert.deepEqual(restarted.dsh.profile.bundles, [...oldManifest.dsh.profile.bundles, autoReview]);
  assert.equal(restarted.dsh.profile.futurePreference, 'keep');
  assert.equal(await readFile(patchFile, 'utf8'), changedPatch);
});

test('invalid profile manifests do not commit the feature marker and a repaired profile can retry', { skip: !runtime }, async t => {
  const root = await temporaryHome(t, 'rufa-profile-retry-');
  const directory = join(root, 'profiles/web'); await mkdir(directory, { recursive: true });
  const manifestFile = join(directory, 'package.json'), patchFile = join(directory, 'cordis.patch.yml'), marker = join(directory, '.rufa-feature-defaults-v1');
  await writeFile(manifestFile, '{invalid json'); await writeFile(patchFile, '[]\n');
  await assert.rejects(initializeProfileDefaults(root, runtime, 'approved'));
  assert.equal(await readFile(manifestFile, 'utf8'), '{invalid json');
  assert.equal(await readFile(patchFile, 'utf8'), '[]\n');
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  await writeFile(manifestFile, JSON.stringify({ name: 'repaired-profile', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }));
  await initializeProfileDefaults(root, runtime, 'approved');
  assert.deepEqual(JSON.parse(await readFile(manifestFile, 'utf8')).dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', autoReview, ...defaults, ...office, sidebar, ...media, agentTeam, badgeSkill]);
  assert.equal((await readFile(marker, 'utf8')).trim(), '1');
});

test('an existing feature marker does not prevent office migration; later independent plugin preferences survive', { skip: !runtime }, async t => {
  const home = await temporaryHome(t, 'rufa-profile-office-upgrade-');
  const directory = join(home, 'profiles/web'), manifestFile = join(directory, 'package.json');
  await writeFile(join(directory, '.rufa-defaults-v1'), '1\n');
  await writeFile(join(directory, '.rufa-feature-defaults-v1'), '1\n');
  const source = '# My OCR settings\n- id: file-upload-ocr\n  config: { dpi: 96, maxPages: 5 }\n';
  await writeFile(join(directory, 'cordis.patch.yml'), source);
  await initializeProfileDefaults(home, runtime, 'approved');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', autoReview, ...office, sidebar, ...media, agentTeam, badgeSkill]);
  assert.equal(await readFile(join(directory, 'cordis.patch.yml'), 'utf8'), source);
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(name => name !== office[1]);
  await writeFile(manifestFile, JSON.stringify(manifest));
  const later = `${source}- id: skill-office\n  disabled: true\n`;
  await writeFile(join(directory, 'cordis.patch.yml'), later);
  await initializeProfileDefaults(home, runtime, 'approved');
  assert.deepEqual(JSON.parse(await readFile(manifestFile, 'utf8')), manifest);
  assert.equal(await readFile(join(directory, 'cordis.patch.yml'), 'utf8'), later);
});

test('missing shipped bundles fail before committing office migration and a repaired installation retries', { skip: !runtime }, async t => {
  const home = await temporaryHome(t, 'rufa-missing-office-');
  const shadow = await runtimeWithoutPreinstalled(home), account = join(home, 'account');
  await assert.rejects(initializeProfileDefaults(account, shadow, 'approved'), /预装办公插件/);
  await assert.rejects(readFile(join(account, 'profiles/web/.rufa-office-defaults-v1')), { code: 'ENOENT' });
  await fixtureBundles(account);
  await initializeProfileDefaults(account, shadow, 'approved');
  const manifest = JSON.parse(await readFile(join(account, 'profiles/web/package.json'), 'utf8'));
  for (const name of office) assert.equal(manifest.dsh.profile.bundles.filter(value => value === name).length, 1);
  assert.equal((await readFile(join(account, 'profiles/web/.rufa-office-defaults-v1'), 'utf8')).trim(), '1');
});

test('sidebar seeds independently in employee and administrator profiles without reopening disabled Office bundles', { skip: !runtime }, async t => {
  const root = await temporaryHome(t, 'rufa-sidebar-accounts-');
  for (const role of ['employee', 'admin']) {
    const account = join(root, role), directory = join(account, 'profiles/web');
    await fixtureBundles(account);
    for (const marker of ['.rufa-defaults-v1', '.rufa-feature-defaults-v1', '.rufa-office-defaults-v1']) await writeFile(join(directory, marker), ' 1\n');
    const base = { name: `${role}-profile`, private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', autoReview] } } };
    const file = join(directory, 'package.json'), patch = join(directory, 'cordis.patch.yml');
    await writeFile(file, JSON.stringify(base));
    const preferences = '# Preserve sidebar preferences\n- id: better-sidebar\n  config: { savedPreference: 42 }\n';
    await writeFile(patch, preferences);
    await initializeProfileDefaults(account, runtime, 'approved');
    const updated = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(updated.dsh.profile.bundles, [...base.dsh.profile.bundles, sidebar, ...media, agentTeam, badgeSkill]);
    assert.equal(await readFile(join(directory, '.rufa-office-defaults-v1'), 'utf8'), ' 1\n');
    assert.equal(await readFile(patch, 'utf8'), preferences);
    const disabled = `${preferences}  disabled: true\n`;
    await writeFile(file, JSON.stringify(base)); await writeFile(patch, disabled);
    await initializeProfileDefaults(account, runtime, 'approved');
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), base);
    assert.equal(await readFile(patch, 'utf8'), disabled);
    assert.equal((await readFile(join(directory, '.rufa-better-sidebar-defaults-v1'), 'utf8')).trim(), '1');
  }
});

test('missing sidebar fails only its new migration and repairs without changing the existing Office marker', { skip: !runtime }, async t => {
  const root = await temporaryHome(t, 'rufa-sidebar-missing-'), shadow = await runtimeWithoutPreinstalled(root);
  const account = join(root, 'account'), directory = join(account, 'profiles/web');
  await mkdir(directory, { recursive: true });
  for (const marker of ['.rufa-defaults-v1', '.rufa-feature-defaults-v1', '.rufa-office-defaults-v1']) await writeFile(join(directory, marker), ' 1\n');
  await assert.rejects(initializeProfileDefaults(account, shadow, 'approved'), /预装侧栏插件/);
  await assert.rejects(readFile(join(directory, '.rufa-better-sidebar-defaults-v1')), { code: 'ENOENT' });
  assert.equal(await readFile(join(directory, '.rufa-office-defaults-v1'), 'utf8'), ' 1\n');
  await fixtureSidebar(account); await fixtureMediaPreview(account);
  await initializeProfileDefaults(account, shadow, 'approved');
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  assert.equal(manifest.dsh.profile.bundles.filter(name => name === sidebar).length, 1);
  assert.ok(office.every(name => !manifest.dsh.profile.bundles.includes(name)));
  assert.equal(await readFile(join(directory, '.rufa-office-defaults-v1'), 'utf8'), ' 1\n');
});

const earlierMarkers = ['.rufa-defaults-v1', '.rufa-feature-defaults-v1', '.rufa-office-defaults-v1', '.rufa-better-sidebar-defaults-v1'];
async function seedEarlierMarkers(directory) {
  await mkdir(directory, { recursive: true });
  for (const marker of earlierMarkers) await writeFile(join(directory, marker), ' 1\n');
}

test('media viewers migrate independently for both roles and preserve disabled Sidebar, Office and later viewer preferences', { skip: !runtime }, async t => {
  const root = await temporaryHome(t, 'rufa-media-accounts-');
  const shadow = await runtimeWithoutPreinstalled(root);
  for (const role of ['employee', 'admin']) {
    const account = join(root, role), directory = join(account, 'profiles/web');
    await seedEarlierMarkers(directory);
    await fixtureMediaPreview(account);
    const manifestFile = join(directory, 'package.json'), patchFile = join(directory, 'cordis.patch.yml');
    const base = { name: `${role}-profile`, description: 'preserve metadata', private: true,
      dsh: { extra: { preserved: true }, profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', autoReview], savedPreference: 42 } } };
    const original = '# Preserve disabled existing features\n- id: better-sidebar\n  disabled: true\n  config: { savedPreference: 42 }\n- id: skill-office\n  disabled: !!js "true"\n- id: better-sidebar-audio\n  config: { savedPreference: 73 }\n';
    await writeFile(manifestFile, JSON.stringify(base)); await writeFile(patchFile, original);
    await initializeProfileDefaults(account, shadow, 'approved');
    const updated = JSON.parse(await readFile(manifestFile, 'utf8'));
    assert.deepEqual(updated, { ...base, dsh: { ...base.dsh, profile: { ...base.dsh.profile, bundles: [...base.dsh.profile.bundles, ...media, agentTeam, badgeSkill] } } });
    assert.equal(await readFile(patchFile, 'utf8'), original);
    for (const marker of earlierMarkers) assert.equal(await readFile(join(directory, marker), 'utf8'), ' 1\n');
    assert.equal(await readFile(join(directory, '.rufa-media-preview-defaults-v1'), 'utf8'), '1\n');

    // Keep one bundle while disabling its row; remove the other bundle entirely.
    updated.dsh.profile.bundles = [...base.dsh.profile.bundles, media[1]];
    const savedManifest = JSON.stringify(updated), later = `${original}  disabled: true\n`;
    await writeFile(manifestFile, savedManifest); await writeFile(patchFile, later);
    await initializeProfileDefaults(account, shadow, 'different');
    assert.equal(await readFile(manifestFile, 'utf8'), savedManifest);
    assert.equal(await readFile(patchFile, 'utf8'), later);
    for (const marker of earlierMarkers) assert.equal(await readFile(join(directory, marker), 'utf8'), ' 1\n');
  }
});

test('either missing media bundle prevents migration commit and repairs without reopening older features', { skip: !runtime }, async t => {
  const root = await temporaryHome(t, 'rufa-media-missing-'), shadow = await runtimeWithoutPreinstalled(root);
  for (const missing of media) {
    const account = join(root, missing === media[0] ? 'video' : 'audio'), directory = join(account, 'profiles/web');
    await seedEarlierMarkers(directory);
    await fixtureMediaPreview(account, media.filter(name => name !== missing));
    await assert.rejects(initializeProfileDefaults(account, shadow, 'approved'), /预装音视频预览插件/);
    await assert.rejects(readFile(join(directory, '.rufa-media-preview-defaults-v1')), { code: 'ENOENT' });
    for (const marker of earlierMarkers) assert.equal(await readFile(join(directory, marker), 'utf8'), ' 1\n');
    await fixtureMediaPreview(account, [missing]);
    await initializeProfileDefaults(account, shadow, 'approved');
    const manifestText = await readFile(join(directory, 'package.json'), 'utf8');
    const bundles = JSON.parse(manifestText).dsh.profile.bundles;
    for (const name of media) assert.equal(bundles.filter(value => value === name).length, 1);
    assert.ok([...office, sidebar, ...defaults].every(name => !bundles.includes(name)));
    assert.equal(await readFile(join(directory, '.rufa-media-preview-defaults-v1'), 'utf8'), '1\n');
    await initializeProfileDefaults(account, shadow, 'approved');
    assert.equal(await readFile(join(directory, 'package.json'), 'utf8'), manifestText);
  }
});

test('a media package present on disk but skipped by native bundle loading does not commit its marker', { skip: !runtime }, async t => {
  const root = await temporaryHome(t, 'rufa-media-skipped-'), shadow = await runtimeWithoutPreinstalled(root);
  const account = join(root, 'account'), directory = join(account, 'profiles/web');
  await seedEarlierMarkers(directory); await fixtureMediaPreview(account);
  // A published package alone is insufficient: the native loader must resolve a bundle layer.
  await writeFile(join(directory, 'node_modules', media[0], 'package.json'), JSON.stringify({ name: media[0], version: '0.1.4' }));
  await assert.rejects(initializeProfileDefaults(account, shadow, 'approved'), /预装音视频预览插件/);
  await assert.rejects(readFile(join(directory, '.rufa-media-preview-defaults-v1')), { code: 'ENOENT' });
  for (const marker of earlierMarkers) assert.equal(await readFile(join(directory, marker), 'utf8'), ' 1\n');
  await fixtureMediaPreview(account, [media[0]]);
  await initializeProfileDefaults(account, shadow, 'approved');
  assert.equal(await readFile(join(directory, '.rufa-media-preview-defaults-v1'), 'utf8'), '1\n');
});

test('Agent Teams seeds independently for both roles using the official layer, then preserves a later disable', { skip: !runtime }, async t => {
  const root = await temporaryHome(t, 'rufa-team-accounts-'), shadow = await runtimeWithoutPreinstalled(root);
  const runtimeRequire = createRequire(join(runtime, 'package.json'));
  const { loadProfile } = await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-app-boot')).href);
  const official = JSON.parse(await readFile(runtimeRequire.resolve(`${agentTeam}/package.json`), 'utf8'));
  for (const name of Object.keys(official.dependencies)) assert.ok(runtimeRequire.resolve(name));
  for (const role of ['employee', 'admin']) {
    const account = join(root, role), directory = join(account, 'profiles/web');
    await seedEarlierMarkers(directory);
    await writeFile(join(directory, '.rufa-media-preview-defaults-v1'), ' 1\n');
    const manifestFile = join(directory, 'package.json'), patchFile = join(directory, 'cordis.patch.yml');
    const base = { name: `${role}-profile`, private: true, description: 'preserved metadata',
      dsh: { extra: { preserve: true }, profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', autoReview], savedPreference: 42 } } };
    const original = '# Do not reopen previous plugins\n- id: better-sidebar\n  disabled: true\n- id: skill-office\n  disabled: !!js "true"\n';
    await writeFile(manifestFile, JSON.stringify(base)); await writeFile(patchFile, original);
    await initializeProfileDefaults(account, shadow, 'approved');
    const migrated = JSON.parse(await readFile(manifestFile, 'utf8'));
    assert.deepEqual(migrated, { ...base, dsh: { ...base.dsh, profile: { ...base.dsh.profile, bundles: [...base.dsh.profile.bundles, agentTeam, badgeSkill] } } });
    const layers = loadProfile('dsh', 'web', join(shadow, 'package.json'), account, { userLayer: false }).layers;
    assert.equal(layers.filter(layer => layer.packageName === agentTeam).length, 1);
    assert.equal(await readFile(patchFile, 'utf8'), original);
    assert.equal(await readFile(join(directory, '.rufa-agent-team-defaults-v1'), 'utf8'), '1\n');
    for (const marker of [...earlierMarkers, '.rufa-media-preview-defaults-v1']) assert.equal(await readFile(join(directory, marker), 'utf8'), ' 1\n');

    const savedManifest = JSON.stringify(base), later = `${original}- id: agent-team\n  disabled: true\n`;
    await writeFile(manifestFile, savedManifest); await writeFile(patchFile, later);
    await initializeProfileDefaults(account, shadow, 'different');
    assert.equal(await readFile(manifestFile, 'utf8'), savedManifest);
    assert.equal(await readFile(patchFile, 'utf8'), later);
    assert.ok(!loadProfile('dsh', 'web', join(shadow, 'package.json'), account, { userLayer: false }).layers.some(layer => layer.packageName === agentTeam));
  }
});

test('missing or invalid Agent Teams bundle does not commit migration; repairing the official layer retries once', { skip: !runtime }, async t => {
  const root = await temporaryHome(t, 'rufa-team-missing-'), shadow = await runtimeWithoutPreinstalled(root, false);
  const account = join(root, 'account'), directory = join(account, 'profiles/web');
  await seedEarlierMarkers(directory); await writeFile(join(directory, '.rufa-media-preview-defaults-v1'), ' 1\n');
  const marker = join(directory, '.rufa-agent-team-defaults-v1');
  await assert.rejects(initializeProfileDefaults(account, shadow, 'approved'), /预装智能体团队插件/);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  const packageRoot = join(directory, 'node_modules', agentTeam);
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: agentTeam, version: '0.2.1-rc.2' }));
  await assert.rejects(initializeProfileDefaults(account, shadow, 'approved'), /预装智能体团队插件/);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  const runtimeRequire = createRequire(join(runtime, 'package.json'));
  for (const name of ['package.json', 'cordis.patch.yml']) await cp(runtimeRequire.resolve(`${agentTeam}/${name}`), join(packageRoot, name));
  await initializeProfileDefaults(account, shadow, 'approved');
  const file = join(directory, 'package.json'), saved = await readFile(file, 'utf8');
  const bundles = JSON.parse(saved).dsh.profile.bundles;
  assert.equal(bundles.filter(name => name === agentTeam).length, 1);
  assert.ok([...office, sidebar, ...media, ...defaults].every(name => !bundles.includes(name)));
  assert.equal(await readFile(marker, 'utf8'), '1\n');
  await initializeProfileDefaults(account, shadow, 'approved');
  assert.equal(await readFile(file, 'utf8'), saved);
});

const beforeBadgeMarkers = [...earlierMarkers, '.rufa-media-preview-defaults-v1', '.rufa-agent-team-defaults-v1'];
async function seedBeforeBadge(directory) {
  await mkdir(directory, { recursive: true });
  for (const marker of beforeBadgeMarkers) await writeFile(join(directory, marker), ' 1\n');
}

test('official badge defaults migrate independently for employee and admin and preserve later row or bundle disabling', { skip: !runtime }, async t => {
  const root = await temporaryHome(t, 'rufa-badge-accounts-'), shadow = await runtimeWithoutPreinstalled(root);
  const runtimeRequire = createRequire(join(runtime, 'package.json'));
  const { loadProfile } = await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-app-boot')).href);
  const official = JSON.parse(await readFile(runtimeRequire.resolve(`${badgeSkill}/package.json`), 'utf8'));
  assert.equal(official.version, '0.2.1-rc.2');
  for (const name of Object.keys(official.dependencies)) assert.ok(runtimeRequire.resolve(name));
  for (const role of ['employee', 'admin']) {
    const account = join(root, role), directory = join(account, 'profiles/web'); await seedBeforeBadge(directory);
    const manifestFile = join(directory, 'package.json'), patchFile = join(directory, 'cordis.patch.yml');
    const base = { name: `${role}-badge-profile`, description: 'preserve unrelated metadata', private: true,
      dsh: { extra: { preserve: true }, profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', autoReview], savedPreference: 42 } } };
    const original = '# Preserve existing choices\n- id: agent-team\n  disabled: true\n- id: skill-office\n  disabled: !!js "true"\n- id: skill-badge\n  config: { savedPreference: 73 }\n';
    await writeFile(manifestFile, JSON.stringify(base)); await writeFile(patchFile, original);
    await initializeProfileDefaults(account, shadow, 'approved');
    const migrated = JSON.parse(await readFile(manifestFile, 'utf8'));
    assert.deepEqual(migrated, { ...base, dsh: { ...base.dsh, profile: { ...base.dsh.profile, bundles: [...base.dsh.profile.bundles, badgeSkill] } } });
    assert.equal(loadProfile('dsh', 'web', join(shadow, 'package.json'), account, { userLayer: false }).layers.filter(layer => layer.packageName === badgeSkill).length, 1);
    assert.equal(await readFile(patchFile, 'utf8'), original);
    assert.equal(await readFile(join(directory, '.rufa-badge-skill-defaults-v1'), 'utf8'), '1\n');
    for (const marker of beforeBadgeMarkers) assert.equal(await readFile(join(directory, marker), 'utf8'), ' 1\n');

    // Both native disabling routes survive subsequent launches.
    const disabledRow = `${original}  disabled: true\n`, retained = JSON.stringify(migrated);
    await writeFile(manifestFile, retained); await writeFile(patchFile, disabledRow);
    await initializeProfileDefaults(account, shadow, 'different');
    assert.equal(await readFile(manifestFile, 'utf8'), retained); assert.equal(await readFile(patchFile, 'utf8'), disabledRow);
    const removed = JSON.stringify(base); await writeFile(manifestFile, removed);
    await initializeProfileDefaults(account, shadow, 'different');
    assert.equal(await readFile(manifestFile, 'utf8'), removed); assert.equal(await readFile(patchFile, 'utf8'), disabledRow);
    assert.ok(!loadProfile('dsh', 'web', join(shadow, 'package.json'), account, { userLayer: false }).layers.some(layer => layer.packageName === badgeSkill));
  }
});

test('missing or native-skipped badge bundle leaves its marker uncommitted and a repaired official layer retries once', { skip: !runtime }, async t => {
  const root = await temporaryHome(t, 'rufa-badge-missing-'), shadow = await runtimeWithoutPreinstalled(root, true, false);
  const account = join(root, 'account'), directory = join(account, 'profiles/web'); await seedBeforeBadge(directory);
  const marker = join(directory, '.rufa-badge-skill-defaults-v1'), patchFile = join(directory, 'cordis.patch.yml');
  const original = '# keep custom YAML\n- id: unrelated\n  disabled: !!js "true"\n'; await writeFile(patchFile, original);
  await assert.rejects(initializeProfileDefaults(account, shadow, 'approved'), /预装公司徽章插件/);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  for (const prior of beforeBadgeMarkers) assert.equal(await readFile(join(directory, prior), 'utf8'), ' 1\n');
  const packageRoot = join(directory, 'node_modules', badgeSkill); await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: badgeSkill, version: '0.2.1-rc.2' }));
  await assert.rejects(initializeProfileDefaults(account, shadow, 'approved'), /预装公司徽章插件/);
  await assert.rejects(readFile(marker), { code: 'ENOENT' }); assert.equal(await readFile(patchFile, 'utf8'), original);
  const runtimeRequire = createRequire(join(runtime, 'package.json'));
  for (const name of ['package.json', 'cordis.patch.yml']) await cp(runtimeRequire.resolve(`${badgeSkill}/${name}`), join(packageRoot, name));
  await initializeProfileDefaults(account, shadow, 'approved');
  const manifestFile = join(directory, 'package.json'), saved = await readFile(manifestFile, 'utf8');
  const bundles = JSON.parse(saved).dsh.profile.bundles;
  assert.equal(bundles.filter(name => name === badgeSkill).length, 1);
  assert.ok([...office, sidebar, ...media, ...defaults, agentTeam].every(name => !bundles.includes(name)));
  assert.equal(await readFile(marker, 'utf8'), '1\n');
  await initializeProfileDefaults(account, shadow, 'different');
  assert.equal(await readFile(manifestFile, 'utf8'), saved); assert.equal(await readFile(patchFile, 'utf8'), original);
});

test('a new account does not commit any default marker before the requested badge layer loads', { skip: !runtime }, async t => {
  const root = await temporaryHome(t, 'rufa-badge-first-run-failure-'), shadow = await runtimeWithoutPreinstalled(root, true, false);
  const account = join(root, 'account'), directory = join(account, 'profiles/web'); await fixtureBundles(account);
  await assert.rejects(initializeProfileDefaults(account, shadow, 'approved'), /预装公司徽章插件/);
  for (const marker of [...beforeBadgeMarkers, '.rufa-badge-skill-defaults-v1']) await assert.rejects(readFile(join(directory, marker)), { code: 'ENOENT' });
  const packageRoot = join(directory, 'node_modules', badgeSkill), runtimeRequire = createRequire(join(runtime, 'package.json'));
  await mkdir(packageRoot, { recursive: true });
  for (const name of ['package.json', 'cordis.patch.yml']) await cp(runtimeRequire.resolve(`${badgeSkill}/${name}`), join(packageRoot, name));
  await initializeProfileDefaults(account, shadow, 'approved');
  for (const marker of [...beforeBadgeMarkers, '.rufa-badge-skill-defaults-v1']) assert.equal(await readFile(join(directory, marker), 'utf8'), '1\n');
});
