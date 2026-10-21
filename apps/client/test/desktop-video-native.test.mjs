import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CompanyApi } from '../dist/company-api.js';
import { RuntimeBridge } from '../dist/runtime-bridge.js';
import { AdminTools } from '../dist/admin-tools.js';
import { enterpriseOverlay, sanitizedRuntimeEnvironment } from '../dist/harness-host.js';
import { initializeProfileDefaults } from '../dist/runtime-configuration.js';
import { applyCompanyPreset } from '../dist/company-preset.js';
import { initializeDesktopVideoDefaults, computerUseDefaults, computerUseTools, computerUseBundle, remotionSkillBundle } from '../dist/desktop-video-defaults.js';

test('real native Harness discovers all desktop tools and lazy skill, preserves review and independent disable across restart',
  { skip: !process.env.RUFA_RUNTIME_ROOT, timeout: 180000 }, async t => {
    const root = process.env.RUFA_RUNTIME_ROOT, temporary = await mkdtemp(join(tmpdir(), 'rufa-desktop-video-native-'));
    const manifest = JSON.parse(await readFile(join(root, 'rufa-runtime.json'), 'utf8'));
    const user = { id: 'desktop-video-test', username: 'desktop-video-test', displayName: 'Synthetic employee', jobTitle: '', role: 'employee' };
    let gatewayCalls = 0;
    const company = createServer(async (req, res) => {
      for await (const chunk of req) { /* consume without logging */ }
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/v1/auth/login') return res.end(JSON.stringify({ user, accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', deviceId: 'synthetic-device', expiresAt: new Date(Date.now() + 3600000).toISOString() }));
      if (req.headers.authorization !== 'Bearer synthetic-access') { res.statusCode = 401; return res.end('{}'); }
      if (req.url === '/api/v1/auth/me') return res.end(JSON.stringify({ user }));
      if (req.url === '/api/v1/models') return res.end(JSON.stringify({ models: [{ id: 'deepseek-flash', displayName: 'Synthetic model', inputModalities: ['text', 'image'] }] }));
      if (req.url.startsWith('/api/v1/sessions')) return res.end(JSON.stringify({ sessions: [] }));
      if (req.url.includes('/gateway/')) gatewayCalls++;
      res.statusCode = 404; res.end('{}');
    });
    await new Promise(resolve => company.listen(0, '127.0.0.1', resolve));
    const api = new CompanyApi({ read: async () => null, write: async () => {}, clear: async () => {} }, true);
    await api.login(`http://127.0.0.1:${company.address().port}`, user.username, 'Synthetic-password');
    const bridge = new RuntimeBridge(api, new AdminTools(api, { confirm: async () => false, revealPassword: async () => { throw new Error('Not used'); } }));
    await bridge.start();
    const overlay = enterpriseOverlay(fileURLToPath(new URL('../dist/runtime', import.meta.url)), 'deepseek-flash', ['deepseek-flash'], user, temporary, root);
    overlay.push({ insert: [{ id: 'rufa-test-desktop-video-probe', name: new URL('./fixtures/desktop-video-probe.mjs', import.meta.url).href }] });
    const overlayPath = join(temporary, 'overlay.json'); await writeFile(overlayPath, JSON.stringify(overlay));
    let child, serial = 0, diagnostics = ''; const pending = new Map();
    const send = (action, values = {}) => new Promise((resolve, reject) => {
      const idNumber = ++serial, timer = setTimeout(() => { pending.delete(idNumber); reject(new Error(`Timed out: ${action}`)); }, 30000);
      pending.set(idNumber, result => { clearTimeout(timer); result.error ? reject(new Error(result.error)) : resolve(result.result); });
      child.send({ type: action === 'desktop-video' ? 'rufa:test-desktop-video' : 'rufa:test-profile', action, idNumber, ...values });
    });
    async function stop() {
      if (!child || child.exitCode !== null) return;
      const ended = once(child, 'exit'), timer = setTimeout(() => child.kill(), 12000);
      child.send({ type: 'rufa:shutdown' });
      const [code] = await ended; clearTimeout(timer); assert.equal(code, 0);
    }
    t.after(async () => { try { await stop(); } finally { await bridge.stop(); await new Promise(resolve => company.close(resolve)); await writeFile(join(temporary, 'diagnostics.txt'), diagnostics); } });
    async function start() {
      await initializeProfileDefaults(temporary, root, 'deepseek-flash'); await applyCompanyPreset(temporary, root, 'deepseek-flash');
      await initializeDesktopVideoDefaults(temporary, root);
      const env = { ...sanitizedRuntimeEnvironment(process.env), PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH}`, DSH_HOME: temporary, DSH_AGENTS_HOME: join(temporary, 'external-agents'), RUFA_RUNTIME_ROOT: root, RUFA_BRIDGE_ORIGIN: bridge.origin, RUFA_BRIDGE_TOKEN: bridge.token, RUFA_DEVICE_ID: 'synthetic-device' };
      child = spawn(process.execPath, ['--expose-internals', join(root, manifest.cli), '--profile', 'web', '--patch', overlayPath, '--no-open', '--host', '127.0.0.1', '--port', '0'], { cwd: temporary, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      child.on('message', message => { if (message?.type === 'rufa:test-profile-result') { pending.get(message.id)?.(message); pending.delete(message.id); } });
      child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk.toString().replaceAll(bridge.token, '[redacted]')).slice(-50000); });
      await new Promise((resolve, reject) => {
        let output = ''; const timer = setTimeout(() => reject(new Error('Harness startup timeout')), 60000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`Harness exit ${code}`)); });
        child.stdout.on('data', chunk => { output = (output + chunk).slice(-4000); if (/dsh web:\s+http:\/\/127\.0\.0\.1/.test(output)) { clearTimeout(timer); resolve(); } });
      });
    }
    async function capability(expectTools, expectSkill) {
      let value;
      const deadline = Date.now() + 15000;
      do { value = await send('desktop-video'); if (value.tools.length === (expectTools ? 24 : 0)) break; await new Promise(resolve => setTimeout(resolve, 100)); } while (Date.now() < deadline);
      assert.deepEqual(value.tools.sort(), expectTools ? computerUseTools.map(name => `mcp__wincu__windows_computer_use_${name}`).sort() : []);
      assert.equal(value.computerTasksReady, true);
      assert.equal(value.mainTools.includes('company_computer_task'), expectTools);
      assert.equal(value.mainTools.some(name => name.startsWith('mcp__wincu__windows_computer_use_')), false);
      assert.equal(value.hints.length, expectTools ? 1 : 0); assert.equal(Boolean(value.catalog), expectSkill);
      assert.equal(value.reviewReady, true);
      if (expectSkill) { assert.equal(value.catalog.content, undefined); assert.match(value.catalog.description, /先加载/); }
      assert(!value.prompt.includes('## Rufajx-DSH 本机运行环境'), 'Skill body is absent before invocation');
      return value;
    }
    await start(); const initial = await capability(true, true);
    for (const [key, value] of Object.entries(computerUseDefaults)) assert.deepEqual(initial.config[key], value, key);
    const loaded = (await send('desktop-video', { load: true })).loaded;
    const originalSkill = await readFile(join(root, 'company-tools/remotion/remotion-motion-graphics/SKILL.md'), 'utf8');
    const originalBody = originalSkill.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, '').trim();
    assert(loaded.content.startsWith(originalBody)); assert.match(loaded.content, /Rufajx-DSH 本机运行环境/); assert.match(loaded.content, /runner.mjs/);
    const review = await send('auto-review'); assert.equal(review.defaultPreset, 'auto'); assert.equal(review.switchBlocked, true);
    assert.deepEqual(review.modes.map(row => row.policy), ['ask', 'ask', 'never']);
    assert.equal((await send('bundle', { name: '@deepseek-ai/dsh-experimental-auto-review', enabled: false })).application, 'failed');
    assert.equal((await send('bundle', { name: computerUseBundle, enabled: false })).application, 'applied'); await capability(false, true);
    assert.equal((await send('bundle', { name: remotionSkillBundle, enabled: false })).application, 'applied'); await capability(false, false);
    await stop(); await start(); await capability(false, false);
    assert.equal((await send('bundle', { name: remotionSkillBundle, enabled: true })).application, 'applied'); await capability(false, true);
    assert.equal((await send('bundle', { name: computerUseBundle, enabled: true })).application, 'applied'); await capability(true, true);
    assert.equal(gatewayCalls, 0); t.diagnostic(`Native fixture ${temporary}: 24 tools registered; no desktop input or model calls.`);
  });
