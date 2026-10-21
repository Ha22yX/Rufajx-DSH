import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, writeFile, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, delimiter } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const clientRoot = resolve(process.env.RUFA_TEST_CLIENT_ROOT ?? fileURLToPath(new URL('../apps/client/', import.meta.url)));
const client = file => import(pathToFileURL(join(clientRoot, 'dist', file)).href);
const { CompanyApi } = await client('company-api.js');
const { RuntimeBridge } = await client('runtime-bridge.js');
const { AdminTools } = await client('admin-tools.js');
const { enterpriseOverlay, sanitizedRuntimeEnvironment } = await client('harness-host.js');
const { initializeProfileDefaults } = await client('runtime-configuration.js');
const { applyCompanyPreset } = await client('company-preset.js');

const runtime = process.env.RUFA_RUNTIME_ROOT;
test('actual CLI profile can edit settings, toggle plugins, reload, and restore with company routing intact', { skip: !runtime, timeout: 180_000 }, async t => {
  const root = await realpath(resolve(runtime));
  const manifest = JSON.parse(await readFile(join(root, 'rufa-runtime.json'), 'utf8'));
  const temporary = await mkdtemp(join(tmpdir(), 'rufa-profile-reload-'));
  async function skill(directory, name) {
    const path = join(directory, name); await mkdir(path, { recursive: true });
    await writeFile(join(path, 'SKILL.md'), `---\nname: ${name}\ndescription: Isolated fixture ${name}\n---\nDo not call any model.\n`);
  }
  await skill(join(temporary, 'skills'), 'rufa-account-only');
  await skill(join(temporary, 'external-agents', 'skills'), 'foreign-agent-skill');
  await skill(join(temporary, 'external-workspace', '.agents', 'skills'), 'foreign-project-skill');
  await skill(join(temporary, 'external-workspace', '.dsh', 'skills'), 'foreign-dsh-skill');
  const requests = [];
  const user = { id: 'profile-test-user', username: 'profile-test', displayName: 'Profile test', jobTitle: '', role: 'employee' };
  const company = createServer(async (req, res) => {
    requests.push(req.url);
    for await (const chunk of req) { /* Consume request body; never log credentials. */ }
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/v1/auth/login') return res.end(JSON.stringify({ user, accessToken: 'profile-test-access', refreshToken: 'profile-test-refresh', deviceId: 'profile-test-device', expiresAt: new Date(Date.now() + 3600000).toISOString() }));
    if (req.headers.authorization !== 'Bearer profile-test-access') { res.statusCode = 401; return res.end('{}'); }
    if (req.url === '/api/v1/auth/me') return res.end(JSON.stringify({ user }));
    if (req.url === '/api/v1/models') return res.end(JSON.stringify({ models: [{ id: 'deepseek-flash', displayName: 'Test model', inputModalities: ['text', 'image'] }] }));
    if (req.url === '/api/v1/admin/users' && user.role === 'admin') return res.end(JSON.stringify({ users: [{ ...user, status: 'active' }] }));
    if (req.url.startsWith('/api/v1/sessions')) return res.end(JSON.stringify({ sessions: [] }));
    res.statusCode = 404; res.end('{}');
  });
  await new Promise(r => company.listen(0, '127.0.0.1', r));
  const api = new CompanyApi({ read: async () => null, write: async () => {}, clear: async () => {} }, true);
  await api.login(`http://127.0.0.1:${company.address().port}`, 'profile-test', 'isolated-test-password');
  const bridge = new RuntimeBridge(api, new AdminTools(api, { confirm: async () => false, revealPassword: async () => { throw new Error('Read-only runtime smoke must not reveal passwords'); } })); await bridge.start();
  const pluginRoot = join(clientRoot, 'dist/runtime');
  const overlay = enterpriseOverlay(pluginRoot, 'deepseek-flash', ['deepseek-flash'], user, temporary, root);
  overlay.push({ insert: [{ id: 'rufa-test-profile-probe', name: new URL('./fixtures/profile-probe.mjs', import.meta.url).href }] });
  const overlayPath = join(temporary, 'overlay.json');
  await writeFile(overlayPath, JSON.stringify(overlay));
  let child, diagnostics = '', serial = 0;
  const pending = new Map();
  const send = (action, parameters = {}) => new Promise((resolveCommand, reject) => {
    const idNumber = ++serial;
    const timer = setTimeout(() => { pending.delete(idNumber); reject(new Error(`Timed out: ${action}`)); }, 30_000);
    pending.set(idNumber, message => { clearTimeout(timer); message.error ? reject(new Error(message.error)) : resolveCommand(message.result); });
    child.send({ type: 'rufa:test-profile', action, ...parameters, idNumber });
  });
  async function start() {
    await initializeProfileDefaults(temporary, root, 'deepseek-flash');
    await applyCompanyPreset(temporary, root, 'deepseek-flash');
    const env = { ...sanitizedRuntimeEnvironment(process.env), PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH}`, DSH_HOME: temporary, DSH_AGENTS_HOME: join(temporary, 'external-agents'), RUFA_RUNTIME_ROOT: root, RUFA_BRIDGE_ORIGIN: bridge.origin, RUFA_BRIDGE_TOKEN: bridge.token, RUFA_DEVICE_ID: 'profile-test-device' };
    child = spawn(process.execPath, ['--expose-internals', join(root, manifest.cli), '--profile', 'web', '--patch', overlayPath, '--no-open', '--host', '127.0.0.1', '--port', '0'], { cwd: temporary, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.on('message', message => { if (message?.type === 'rufa:test-profile-result') { pending.get(message.id)?.(message); pending.delete(message.id); } });
    child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk.toString().replaceAll(bridge.token, '[redacted]')).slice(-32000); });
    await new Promise((ready, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('CLI startup timed out')), 60_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`CLI exited ${code}`)); });
      child.stdout.on('data', chunk => { output = (output + chunk).slice(-4000); if (/dsh web:\s+http:\/\/127\.0\.0\.1/.test(output)) { clearTimeout(timer); ready(); } });
    });
  }
  async function stop() {
    if (!child || child.exitCode !== null) return;
    let flushed = false;
    child.on('message', message => { if (message?.type === 'rufa:persistence-flushed') flushed = message.ok === true; });
    const stopped = once(child, 'exit');
    const timeout = setTimeout(() => child.kill(), 12_000);
    child.send({ type: 'rufa:shutdown' });
    const [code] = await stopped; clearTimeout(timeout);
    assert.equal(code, 0); assert.equal(flushed, true, 'Cloud session adapter must flush normally');
  }
  const assertCompany = state => {
    for (const id of ['credentials', 'llm-deepseek', 'llm-pi-ai', 'llm-deepseek-account', 'session-persistence-jsonl', 'web-search-deepseek', 'web-deepseek-api']) assert.equal(state.company[id].disabled, true, `${id} must stay disabled`);
    for (const id of ['rufa-brand', 'rufa-credentials', 'rufa-model', 'rufa-persistence', 'rufa-web']) {
      assert.equal(state.company[id].disabled, false, `${id} must stay enabled`);
      assert.equal(state.company[id].active, true, `${id} must remain active`);
    }
  };
  try {
    await start();
    const initial = await send('snapshot');
    t.diagnostic(`Boot module identities: ${JSON.stringify(initial.bootModuleUrls)}`);
    assert.equal(initial.bootModuleUrls.length, 1);
    assert.deepEqual(initial.adminTools, []);
    assertCompany(initial);
    for (const feature of Object.values(initial.defaultFeatures)) assert.equal(feature.active, true);
    assert.equal(initial.defaultFeatures['cot-translation'].config.provider, 'bing');
    assert.equal(initial.defaultFeatures['cot-translation'].config.targetLanguage, 'auto');
    const verifyAutoReview = async () => {
      const state = await send('snapshot');
      assert.equal(state.autoReviewReady, true, JSON.stringify(state.autoReviewEntry));
      const permissions = await send('auto-review');
      assert.equal(permissions.defaultPreset, 'auto');
      assert.equal(permissions.catalog.defaultPreset, 'auto');
      assert.deepEqual(permissions.catalog.options.map(option=>option.value), ['auto']);
      assert.equal(permissions.switchBlocked, true); assert.equal(permissions.seedUnchanged, true);
      assert.deepEqual(permissions.modes, [{ current: 'auto', policy: 'ask' }, { current: 'auto', policy: 'ask' }, { current: 'auto', policy: 'never' }]);
      const disable = await send('bundle', { name: '@deepseek-ai/dsh-experimental-auto-review', enabled: false });
      assert.equal(disable.application, 'failed');
    };
    await verifyAutoReview();
    const verifyPersonas = async () => {
      const personas = await send('personas');
      assert.deepEqual(personas.map(row => row.id), ['standard', 'custom-child-role']);
      for (const { id, sections, contexts } of personas) {
        const prefix = sections.find(section => section.name === 'deployment:persona-prefix')?.text ?? '';
        assert.ok(prefix.startsWith('你是 Rufajx-DSH（RufaDSH），如发机械有限公司的公司智能体'), id);
        assert.equal(prefix.split('你是 Rufajx-DSH（RufaDSH）').length, 2, `${id}: no duplicated company persona`);
        assert.equal(sections.some(section => section.name === 'harness:identity'), false);
        assert.equal(prefix.includes('You are a coding agent'), false);
        const account = contexts.filter(row => row.name === 'company:account');
        assert.equal(account.length, 1);
        assert.equal(account[0].interpolate, false, 'User-authored profile data must not resolve prompt variables');
        assert.ok(account[0].text.includes(user.displayName));
        assert.ok(account[0].text.includes(JSON.stringify(user.jobTitle).slice(1, -1)));
        assert.equal(/accessToken|refreshToken|passwordHash/.test(account[0].text), false);
        if (id === 'custom-child-role') assert.ok(prefix.includes('Review the project schedule only.'));
        else if (id !== 'minimal') assert.ok(sections.some(section => section.name.startsWith('tools:') || section.name.startsWith('tool:')), `${id} retains native tool guidance`);
      }
    };
    await verifyPersonas();
    user.displayName = '更新的姓名'; user.jobTitle = '项目主管 {{unknown_variable}}';
    await verifyPersonas(); // Fresh authenticated account data must replace the startup overlay without a restart.
    const verifyStandardMode = async () => {
      const modes = await send('standard-mode');
      assert.equal(modes.defaultId, 'standard');
      assert.deepEqual(modes.roster.presets.map(row => row.id), ['standard']);
      assert.equal(modes.roster.presets[0].isDefault, true);
      assert.ok(modes.mounted.every(row => row.resolved === 'standard' && row.actual === 'standard'), 'Old saved choices must resume with the Standard composition');
      const plugins = (await send('snapshot')).company;
      for (const id of ['ui-agent-preset', 'ui-settings-plugins', 'ui-settings-plugin-inventory', 'preset-ptc', 'preset-minimal', 'preset-cordis']) {
        assert.equal(plugins[id]?.disabled, true, `${id} must stay disabled`);
        assert.equal(plugins[id]?.active, false, `${id} must not load`);
      }
    };
    await verifyStandardMode();
    assert.deepEqual(await send('badge-capability'), { skill: true, tool: true }, 'standard preset includes the native badge and authenticated tool');
    for (const enabled of [false, true]) {
      const changed = await send('bundle', { name: '@deepseek-ai/dsh-experimental-badge-skill-bundle', enabled });
      assert.equal(changed.application, 'applied', JSON.stringify(changed));
      assert.deepEqual(await send('badge-capability'), { skill: enabled, tool: enabled }, 'badge and metadata tool share the native lifecycle');
    }
    // A prior user default must not revive the removed modes, including after a settings reload.
    await send('config', { id: 'agent-preset-registry', values: { selectedDefault: 'ptc' } });
    await verifyStandardMode();
    const skillCatalog = await send('skills', { cwd: join(temporary, 'external-workspace') });
    for (const row of skillCatalog) {
      if (row.id === 'minimal') continue; // The minimal preset intentionally has no skill filesystem provider.
      assert.ok(row.names.includes('rufa-account-only'), `${row.id} must load the current account skill`);
      assert.equal(row.names.some(name => name.startsWith('foreign-')), false, `${row.id} must not discover other agents or project roots`);
    }
    const bundle = '@deepseek-ai/dsh-experimental-inspector-profile';
    for (const enabled of [true, false, true]) {
      const changed = await send('bundle', { name: bundle, enabled });
      assert.equal(changed.application, 'applied', JSON.stringify(changed));
      assert.equal((await send('snapshot')).bundles.find(row => row.name === bundle)?.enabled, enabled);
      assertCompany(await send('snapshot'));
    }
    const changed = await send('config', { id: 'agent-loop', values: { maxParallelToolCalls: 7 } });
    assert.equal(changed.maxParallelToolCalls, 7);
    await send('reconcile');
    assert.equal((await send('snapshot')).config['agent-loop'].maxParallelToolCalls, 7);
    const theme = await send('config', { id: 'ui-theme', values: { preference: 'dark', fontSize: 15 } });
    assert.equal(theme.fontSize, 15);
    const dependency = await send('plugin', { id: 'llm', enabled: false });
    assert.equal(dependency.application, 'failed');
    const direct = await send('plugin', { id: 'llm-deepseek', enabled: true });
    assert.notEqual(direct.application, 'applied', 'Original direct provider cannot be enabled');
    assertCompany(await send('snapshot'));
    const companyDisable = await send('plugin', { id: 'rufa-model', enabled: false });
    assert.notEqual(companyDisable.application, 'applied', 'Company routing cannot be disabled');
    assertCompany(await send('snapshot'));
    await stop(); await start();
    const restored = await send('snapshot');
    assert.equal(restored.config['agent-loop'].maxParallelToolCalls, 7);
    assert.equal(restored.bundles.find(row => row.name === bundle)?.enabled, true);
    assertCompany(restored);
    assert.equal(restored.config['ui-theme'].fontSize, 15);
    await verifyPersonas();
    await verifyStandardMode();
    await stop();
    user.role = 'admin';
    const adminOverlay = enterpriseOverlay(pluginRoot, 'deepseek-flash', ['deepseek-flash'], user, temporary, root);
    adminOverlay.push(overlay.at(-1));
    await writeFile(overlayPath, JSON.stringify(adminOverlay));
    await start();
    await verifyAutoReview();
    assert.equal((await send('snapshot')).adminTools.length, 9);
    assert.equal(JSON.parse(await send('admin-read')).users[0].username, 'profile-test');
    assert.equal(requests.some(path => path.includes('/gateway/')), false);
    t.diagnostic(`Actual CLI startup, repeated bundle toggles, settings persistence, routing protection and restart verified; isolated profile: ${temporary}`);
  } catch (error) {
    await writeFile(join(temporary, 'diagnostics.log'), diagnostics);
    t.diagnostic(`Failure diagnostics: ${join(temporary, 'diagnostics.log')}`);
    throw error;
  } finally {
    try { await stop(); } finally { await bridge.stop(); company.closeAllConnections(); await new Promise(r => company.close(r)); }
  }
});
