import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { applyCompanyPreset, companyPresetHash } from '../dist/company-preset.js';
import { companyPresetRows, companyPresetBundles, companyPresetDisabledBundles, companyPresetVersion,
  companyPresetMarker, companyPresetDirectory } from '../dist/company-preset-data.js';
import { initializeProfileDefaults } from '../dist/runtime-configuration.js';
import { enterpriseOverlay } from '../dist/harness-host.js';

const runtime = process.env.RUFA_RUNTIME_ROOT;
const req = runtime && createRequire(join(runtime, 'package.json'));
const yaml = req && req('yaml');
const parserOptions = { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] };
async function fixture(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'rufa-company-preset-')));
  t.after(async () => {
    assert.equal(dirname(resolve(home)).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
    assert.ok(basename(home).startsWith('rufa-company-preset-'));
    await rm(home, { force: true, recursive: true });
  });
  await initializeProfileDefaults(home, runtime, 'company-model');
  return { home, profile: join(home, 'profiles/web'), patch: join(home, 'profiles/web/cordis.patch.yml'), manifest: join(home, 'profiles/web/package.json') };
}
const read = path => readFile(path, 'utf8');
const rowsAt = async f => yaml.parse(await read(f.patch), parserOptions);
const rowAt = async (f, id) => (await rowsAt(f)).find(row => row.id === id);
const markerAt = f => join(f.profile, companyPresetMarker);
const journalAt = f => join(f.profile, companyPresetDirectory, 'journal.json');

test('new and existing employee/admin accounts receive the complete reviewed preset, preserving private state and unknown fields', { skip: !runtime }, async t => {
  for (const role of ['employee', 'admin']) for (const existing of [false, true]) {
    const f = await fixture(t);
    const privateFiles = ['browser-ui-state.json', 'company-preferences.json', 'company-preference-projects.json', 'remote-sessions-cache.json'];
    for (const name of privateFiles) await writeFile(join(f.home, name), `private-${role}-${existing}`);
    if (existing) {
      await writeFile(f.patch, `# account comment\n- id: ui-theme\n  config: {preference: light, fontSize: 22, accountOnly: keep}\n- id: locale\n  config: {preference: en}\n- id: agent-default-model\n  config: {provider: deepseek-official, model: company-model, reasoningEffort: high}\n- id: better-sidebar\n  disabled: true\n  config:\n    tabsEnabled: {editor: false, subagent: false, sidechat: false, git: true, terminal-bottom: true, diff: true, 'external:custom': false}\n    viewersEnabled: {markdown: false, video: false}\n    htmlViewerNoSandbox: true\n    pluginSettings: {editor: {openWithPluginTargets: true, openWith: {privatePath: 'Z:/do-not-copy'}}, custom: {untouched: true}}\n- id: custom\n  disabled: !!js "true"\n  config: {privateValue: local-only}\n`);
      const manifest = JSON.parse(await read(f.manifest));
      manifest.customMetadata = 'keep';
      manifest.dsh.profile.bundles.splice(manifest.dsh.profile.bundles.indexOf('dsh-better-sidebar'), 0, 'external-unknown-bundle');
      manifest.dsh.profile.bundles.push(...companyPresetDisabledBundles);
      await writeFile(f.manifest, JSON.stringify(manifest));
    }
    await applyCompanyPreset(f.home, runtime, 'company-model');
    const sidebar = (await rowAt(f, 'better-sidebar')).config;
    assert.deepEqual(Object.fromEntries(['editor', 'subagent', 'sidechat', 'git', 'terminal-bottom', 'diff'].map(k => [k, sidebar.tabsEnabled[k]])),
      { editor: true, subagent: true, sidechat: true, git: false, 'terminal-bottom': false, diff: false });
    assert.deepEqual(sidebar.viewersEnabled, { markdown: true, ...(existing ? { video: true } : {}), html: true, jsonl: true, code: true, 'dsh-audio-preview:audio': true, video: true });
    assert.equal(sidebar.agentOpenTools, true); assert.equal(sidebar.htmlViewerNoSandbox, false);
    assert.equal(sidebar.pluginSettings.editor.openWithPluginTargets, false);
    assert.equal((await rowAt(f, 'better-sidebar')).disabled, undefined);
    assert.equal((await rowAt(f, 'agent-default-model')).config.model, 'company-model');
    assert.equal((await rowAt(f, 'agent-default-model')).config.reasoningEffort, 'low');
    assert.equal((await rowAt(f, 'locale')).config.preference, undefined);
    assert.equal((await rowAt(f, 'ui-chat')).config.transcriptView, 'detailed');
    assert.equal((await rowAt(f, 'ui-theme')).config.fontSize, 14);
    const manifest = JSON.parse(await read(f.manifest));
    for (const name of companyPresetBundles) assert.ok(manifest.dsh.profile.bundles.includes(name));
    for (const name of companyPresetDisabledBundles) assert.equal(manifest.dsh.profile.bundles.includes(name), false);
    if (existing) {
      assert.equal(manifest.customMetadata, 'keep'); assert.match(await read(f.patch), /# account comment/);
      assert.ok(manifest.dsh.profile.bundles.indexOf('external-unknown-bundle') < manifest.dsh.profile.bundles.indexOf('dsh-better-sidebar'));
      assert.match(await read(f.patch), /!!js/); assert.equal(sidebar.tabsEnabled['external:custom'], false);
      assert.equal(sidebar.pluginSettings.editor.openWith.privatePath, 'Z:/do-not-copy');
      assert.equal((await rowAt(f, 'ui-theme')).config.accountOnly, 'keep');
    }
    for (const name of privateFiles) assert.equal(await read(join(f.home, name)), `private-${role}-${existing}`);
    assert.equal(JSON.parse(await read(markerAt(f))).status, 'committed');
    const overlay = enterpriseOverlay('/plugins', 'company-model', ['company-model'], { username: role, displayName: role, role }, f.home, runtime);
    assert.equal(overlay.flatMap(row => row.insert ?? []).some(row => row.id === 'rufa-admin-tools'), role === 'admin');
    assert.ok(overlay.some(row => row.id === 'credentials' && row.disabled === true));
  }
});

test('a committed version preserves subsequent edits, reset-to-default and removed bundles even if snapshot hash differs', { skip: !runtime }, async t => {
  const f = await fixture(t); await applyCompanyPreset(f.home, runtime, 'company-model');
  const personal = '# reset and personal settings\n- id: better-sidebar\n  disabled: true\n  config: {tabsEnabled: {editor: false}}\n';
  await writeFile(f.patch, personal);
  const manifest = JSON.parse(await read(f.manifest));
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(name => name !== 'dsh-better-sidebar');
  await writeFile(f.manifest, JSON.stringify(manifest));
  const marker = JSON.parse(await read(markerAt(f))); marker.hash = 'f'.repeat(64); await writeFile(markerAt(f), JSON.stringify(marker));
  await initializeProfileDefaults(f.home, runtime, 'different-model');
  await applyCompanyPreset(f.home, runtime, 'different-model');
  assert.equal(await read(f.patch), personal); assert.deepEqual(JSON.parse(await read(f.manifest)), manifest);
  assert.deepEqual(JSON.parse(await read(markerAt(f))), marker);
});

for (const stage of ['prepared', 'package', 'patch', 'validated']) test(`failure at ${stage} restores exact originals, leaves no marker and retries`, { skip: !runtime }, async t => {
  const f = await fixture(t), before = [await read(f.manifest), await read(f.patch)];
  await assert.rejects(applyCompanyPreset(f.home, runtime, 'company-model', { checkpoint: current => { if (current === stage) throw new Error('controlled fault'); } }), /controlled fault/);
  assert.equal(await read(f.manifest), before[0]); assert.equal(await read(f.patch), before[1]);
  await assert.rejects(read(markerAt(f)), { code: 'ENOENT' });
  await applyCompanyPreset(f.home, runtime, 'company-model');
  const backup = JSON.parse(await read(join(f.profile, companyPresetDirectory, 'backup.json')));
  assert.equal(backup.files[0].before, before[0]); assert.equal(backup.files[1].before, before[1]);
});

test('an interrupted transaction is recovered on next startup before applying the preset', { skip: !runtime }, async t => {
  const f = await fixture(t); let journal;
  await assert.rejects(applyCompanyPreset(f.home, runtime, 'company-model', { checkpoint: async stage => {
    if (stage === 'prepared') { journal = await read(journalAt(f)); throw new Error('capture'); }
  } }), /capture/);
  const transaction = JSON.parse(journal);
  await writeFile(journalAt(f), journal); await writeFile(f.manifest, transaction.files[0].after);
  await applyCompanyPreset(f.home, runtime, 'company-model');
  assert.equal(JSON.parse(await read(markerAt(f))).version, companyPresetVersion);
  assert.equal(JSON.parse(await read(join(f.profile, companyPresetDirectory, 'backup.json'))).files[0].before, transaction.files[0].before);
  await assert.rejects(read(journalAt(f)), { code: 'ENOENT' });
});

test('concurrent external edits are not overwritten by rollback or recovery', { skip: !runtime }, async t => {
  const f = await fixture(t); let external;
  await assert.rejects(applyCompanyPreset(f.home, runtime, 'company-model', { checkpoint: async stage => {
    if (stage === 'patch') { external = `${await read(f.patch)}\n# simultaneous personal edit\n`; await writeFile(f.patch, external); throw new Error('failure'); }
  } }), /配置发生变化/);
  assert.equal(await read(f.patch), external); await assert.rejects(read(markerAt(f)), { code: 'ENOENT' });
  await assert.rejects(applyCompanyPreset(f.home, runtime, 'company-model'), /配置发生变化/);
  assert.equal(await read(f.patch), external); assert.ok(await read(journalAt(f)));
});

test('dynamic, duplicate or spoofed target rows fail without exposing or rewriting account values', { skip: !runtime }, async t => {
  for (const invalid of ['- id: better-sidebar\n  config: !!js "private-secret-expression"\n',
    '- id: better-sidebar\n- id: better-sidebar\n', '- id: better-sidebar\n  name: untrusted-module\n', 'not: a-sequence\n',
    '- id: better-sidebar\n  remove: true\n', '- id: ui-theme\n  move: other\n',
    '- id: !!js "private-secret-id"\n  config: {}\n',
    '- insert:\n  - id: custom-group\n    name: cordis:group\n    group: true\n    config:\n    - id: better-sidebar\n      name: dsh-better-sidebar\n']) {
    const f = await fixture(t); await writeFile(f.patch, invalid); const originalManifest = await read(f.manifest);
    await assert.rejects(applyCompanyPreset(f.home, runtime, 'company-model'), error => !error.message.includes('private-secret'));
    assert.equal(await read(f.patch), invalid); assert.equal(await read(f.manifest), originalManifest);
    await assert.rejects(read(markerAt(f)), { code: 'ENOENT' });
  }
});

test('redirected migration directories are rejected before backups or markers', { skip: !runtime }, async t => {
  const f = await fixture(t), outside = join(f.home, 'outside'); await mkdir(outside);
  await symlink(outside, join(f.profile, companyPresetDirectory), 'junction');
  const before = await read(f.patch);
  await assert.rejects(applyCompanyPreset(f.home, runtime, 'company-model'));
  assert.equal(await read(f.patch), before); await assert.rejects(read(markerAt(f)), { code: 'ENOENT' });
});

test('same-account concurrent callers share one durable migration', { skip: !runtime }, async t => {
  const f = await fixture(t); let prepared = 0;
  await Promise.all(Array.from({ length: 4 }, () => applyCompanyPreset(f.home, runtime, 'company-model', { checkpoint: stage => { if (stage === 'prepared') prepared++; } })));
  assert.equal(prepared, 1); assert.equal(JSON.parse(await read(markerAt(f))).hash, companyPresetHash);
});

test('a missing required shipped bundle rolls back and a repaired runtime can retry', { skip: !runtime }, async t => {
  const f = await fixture(t), shadow = join(f.home, 'isolated-runtime'); await mkdir(join(shadow, 'node_modules'), { recursive: true });
  await writeFile(join(shadow, 'package.json'), await read(join(runtime, 'package.json')));
  for (const name of ['yaml', '@deepseek-ai/dsh-app-boot', ...companyPresetBundles.filter(name => name !== 'dsh-video-preview')]) {
    const target = join(shadow, 'node_modules', name); await mkdir(dirname(target), { recursive: true });
    await symlink(await realpath(join(runtime, 'node_modules', name)), target, 'junction');
  }
  const before = [await read(f.manifest), await read(f.patch)];
  await assert.rejects(applyCompanyPreset(f.home, shadow, 'company-model'));
  assert.equal(await read(f.manifest), before[0]); assert.equal(await read(f.patch), before[1]);
  await assert.rejects(read(markerAt(f)), { code: 'ENOENT' });
  await applyCompanyPreset(f.home, runtime, 'company-model');
  assert.equal(JSON.parse(await read(markerAt(f))).status, 'committed');
});

test('native profile composition accepts the preset and the frozen schema keys; capabilities remain company-managed', { skip: !runtime }, async t => {
  const f = await fixture(t); await applyCompanyPreset(f.home, runtime, 'company-model');
  const { loadProfile } = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-app-boot')));
  const { applyEntryPatches } = await import(pathToFileURL(req.resolve('@deepseek-ai/cordis-plugin-include')));
  const profile = loadProfile('dsh', 'web', join(runtime, 'package.json'), f.home);
  let entries = []; const warnings = [];
  for (const layer of profile.layers) entries = applyEntryPatches(entries, layer.patches, warning => warnings.push(warning));
  entries = applyEntryPatches(entries, profile.patches, warning => warnings.push(warning));
  assert.deepEqual(warnings, []);
  for (const row of companyPresetRows) {
    const actual = entries.find(entry => entry.id === row.id); assert.ok(actual, row.id);
    assert.equal(actual.name, row.name);
    if (!row.config) continue;
    const mod = await import(pathToFileURL(req.resolve(row.name)));
    const schema = mod.Config ?? mod.default?.Config;
    // Some core services expose Config as a class static; fields without an
    // exported schema are covered by the real native profile integration.
    if (schema?.dict) {
      for (const key of Object.keys(row.config)) assert.ok(Object.hasOwn(schema.dict, key), `${row.id}.${key}`);
      schema(actual.config);
    }
  }
  const presetText = JSON.stringify(companyPresetRows);
  for (const forbidden of ['apiKey', 'Authorization', 'pythonCommand', 'pwshPath', 'cwd', 'sessionId', 'role', 'accountId', 'fontDirectories']) {
    assert.equal(presetText.includes(`"${forbidden}":`), false, forbidden);
  }
  assert.deepEqual(companyPresetRows.find(row => row.id === 'agent-default-model').config, { reasoningEffort: 'low' });
  const sidebar = entries.find(row => row.id === 'better-sidebar').config;
  assert.equal(Object.keys(sidebar.tabsEnabled).length, 6); assert.equal(Object.keys(sidebar.viewersEnabled).length, 6);
});
