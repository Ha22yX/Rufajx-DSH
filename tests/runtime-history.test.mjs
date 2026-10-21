import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, dirname, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../apps/server/dist/app.js';
import { configFromEnv } from '../apps/server/dist/config.js';
import { SqliteStore } from '../apps/server/dist/sqlite-store.js';
import { hashPassword } from '../apps/server/dist/security.js';
import { CompanyApi } from '../apps/client/dist/company-api.js';
import { RuntimeBridge } from '../apps/client/dist/runtime-bridge.js';
import { enterpriseOverlay, sanitizedRuntimeEnvironment } from '../apps/client/dist/harness-host.js';
import { initializeProfileDefaults } from '../apps/client/dist/runtime-configuration.js';
import { patchHistoryRuntime } from '../scripts/history-runtime.mjs';
import { patchContinuationRuntime } from '../apps/client/scripts/continuation-runtime.mjs';
import { patchProjectsRuntime } from '../apps/client/scripts/projects-runtime.mjs';
import { checkPreinstalledRuntime } from '../scripts/preinstalled-runtime.mjs';
import { checkSidebarRuntime } from '../scripts/sidebar-runtime.mjs';
import { checkMediaPreviewRuntime } from '../scripts/media-preview-runtime.mjs';

test('real CLI shows cached cold history, streams another device tail, and only resumes after acquiring ownership', { skip: !process.env.RUFA_RUNTIME_ROOT, timeout: 120000 }, async t => {
  const root = resolve(process.env.RUFA_RUNTIME_ROOT), temporary = await mkdtemp(join(tmpdir(), 'rufa-native-history-'));
  await patchHistoryRuntime(root);
  await patchContinuationRuntime(root);
  await patchProjectsRuntime(root);
  await checkPreinstalledRuntime(root, { syncWrappers: true });
  await checkSidebarRuntime(root);
  await checkMediaPreviewRuntime(root);
  const manifest = JSON.parse(await readFile(join(root, 'rufa-runtime.json'), 'utf8'));
  const store = SqliteStore.open(join(temporary, 'company.sqlite'));
  const password = 'Synthetic-native-history-2026';
  await store.createUser({ username: 'history', displayName: 'History fixture', role: 'admin', passwordHash: await hashPassword(password) }, true);
  const server = buildApp(store, configFromEnv({}), () => store.ping());
  const url = await server.listen({ host: '127.0.0.1', port: 0 });
  let modelCalls = 0;
  const request = (...args) => { if (String(args[0]).includes('/gateway/')) { modelCalls++; throw new Error('Model calls forbidden'); } return fetch(...args); };
  const vault = { read: async () => null, write: async () => {}, clear: async () => {} };
  const api = new CompanyApi(vault, true, request), other = new CompanyApi(vault, true);
  await api.login(url, 'history', password); await other.login(url, 'history', password);
  const header = { id: 'native-history', version: 4, createdAt: Date.now(), cwd: temporary, isSeeded: false, agentPreset: 'standard' };
  await other.json('POST', '/sessions', { id: header.id, upstreamHeader: header, workspaceRef: header.cwd });
  const lease = await other.json('POST', `/sessions/${header.id}/lease`, { deviceId: other.state.deviceId });
  const first = { seq: 0, type: 'turn/start', time: Date.now(), data: { turn: 1 } };
  await other.json('POST', `/sessions/${header.id}/events`, { leaseId: lease.leaseId, expectedNextSeq: 0, events: [{ seq: 0, event: first }] });
  const idleHeader = { ...header, id: 'unleased-cold-history' };
  await other.json('POST', '/sessions', { id: idleHeader.id, upstreamHeader: idleHeader, workspaceRef: idleHeader.cwd });
  const seedLease = await other.json('POST', `/sessions/${idleHeader.id}/lease`, { deviceId: other.state.deviceId });
  await other.json('POST', `/sessions/${idleHeader.id}/events`, { leaseId: seedLease.leaseId, expectedNextSeq: 0, events: [{ seq: 0, event: first }] });
  await other.json('DELETE', `/sessions/${idleHeader.id}/lease`, { leaseId: seedLease.leaseId });
  const bridge = new RuntimeBridge(api); await bridge.start();
  const overlay = enterpriseOverlay(fileURLToPath(new URL('../apps/client/dist/runtime/', import.meta.url)), 'deepseek-flash', ['deepseek-flash'], api.state.user, temporary, root);
  overlay.push({ insert: [{ id: 'rufa-history-probe', name: new URL('./fixtures/history-probe.mjs', import.meta.url).href }] });
  const overlayPath = join(temporary, 'overlay.json'); await writeFile(overlayPath, JSON.stringify(overlay));
  await initializeProfileDefaults(temporary, root, 'deepseek-flash');
  const env = { ...sanitizedRuntimeEnvironment(process.env), PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH}`, DSH_HOME: temporary,
    RUFA_RUNTIME_ROOT: root, RUFA_BRIDGE_ORIGIN: bridge.origin, RUFA_BRIDGE_TOKEN: bridge.token, RUFA_DEVICE_ID: api.state.deviceId };
  const child = spawn(process.execPath, ['--expose-internals', join(root, manifest.cli), '--profile', 'web', '--patch', overlayPath, '--no-open', '--host', '127.0.0.1', '--port', '0'],
    { cwd: temporary, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let diagnostics = '', serial = 0, flushed = false, runtimeOrigin;
  const pending = new Map();
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk.toString().replaceAll(bridge.token, '[redacted]')).slice(-24000); });
  child.on('message', message => {
    if (message?.type === 'rufa:persistence-flushed') flushed = message.ok === true;
    if (message?.type === 'rufa:test-history-result') { pending.get(message.id)?.(message); pending.delete(message.id); }
  });
  const send = (action, values = {}) => new Promise((resolveValue, reject) => {
    const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(new Error(`History probe timeout: ${action}`)); }, 20000);
    pending.set(id, message => { clearTimeout(timer); message.error ? reject(new Error(message.error)) : resolveValue(message.result); });
    child.send({ type: 'rufa:test-history', action, id, ...values });
  });
  try {
    await new Promise((ready, reject) => {
      let output = ''; const timer = setTimeout(() => reject(new Error('CLI startup timeout')), 60000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`CLI exited ${code}`)); });
      child.stdout.on('data', chunk => { output = (output + chunk).slice(-4000); const match = /dsh web:\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(output); if (match) { runtimeOrigin = match[1]; clearTimeout(timer); ready(); } });
    });
    const office = await send('office-plugins');
    assert.deepEqual(office.skills.filter(name => name === 'office' || name.startsWith('office-')).sort(), ['office', 'office-docx', 'office-export-pdf', 'office-pptx', 'office-recalculate', 'office-render', 'office-xlsx']);
    assert.deepEqual(office.plugins.map(row => row.id).sort(), ['better-sidebar', 'better-sidebar-audio', 'file-upload-ocr', 'pdf-reader', 'skill-office', 'video-preview']);
    assert(office.plugins.every(row => row.enabled && !row.readonly), 'Preinstalled plugins must load and remain independently switchable');
    assert(office.browserEntries.includes('dsh-file-upload-ocr-plugin'), 'OCR must be admitted to the browser graph, not merely listed as enabled');
    assert(office.browserEntries.includes('dsh-better-sidebar'), 'Better Sidebar must be admitted to the browser graph');
    for (const name of ['dsh-video-preview', '@huanlin/dsh-plugin-better-sidebar-plugin-audio']) assert(office.browserEntries.includes(name), `${name} must load into the browser graph`);
    // An enabled row/browser bundle alone does not mean the host fiber mounted.
    // Exercise the real host routes and its real browser admission without a cookie.
    for (const route of ['/video', '/audio-preview/meta', '/audio-preview/media']) {
      const response = await fetch(`${runtimeOrigin}${route}`);
      assert.equal(response.status, 401, `${route} must be mounted and require native browser admission`);
      assert.equal((await response.json()).error.code, 'forbidden');
    }
    const opened = await send('follow', { sessionId: header.id });
    assert.equal(opened.frame.cursor, 0, 'An active remote turn must not receive synthetic local closing sequence numbers');
    assert.equal(opened.live, false);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal((await send('state', { sessionId: header.id })).agent, false, 'Following history must not promote to an Agent');
    // With no competing writer, mere observation must still never activate an
    // Agent, acquire a lease, close an interrupted turn or append permissions.
    await send('follow', { sessionId: idleHeader.id });
    await new Promise(resolve => setTimeout(resolve, 350));
    const observed = await send('state', { sessionId: idleHeader.id });
    assert.equal(observed.agent, false); assert.equal(observed.live, false);
    assert.deepEqual((await other.json('GET', `/sessions/${idleHeader.id}/events`)).events, [{ seq: 0, event: first }]);
    const observationLease = await other.json('POST', `/sessions/${idleHeader.id}/lease`, { deviceId: other.state.deviceId });
    await other.json('DELETE', `/sessions/${idleHeader.id}/lease`, { leaseId: observationLease.leaseId });
    const tool = { seq: 1, type: 'tool/call', time: Date.now(), data: { turn: 1, step: 1, callId: 'synthetic-call', name: 'fixture', arguments: '{"exact":true}' } };
    await other.json('POST', `/sessions/${header.id}/events`, { leaseId: lease.leaseId, expectedNextSeq: 1, events: [{ seq: 1, event: tool }] });
    await send('sync', { sessionId: header.id });
    const followed = await send('state', { sessionId: header.id });
    assert.equal(followed.error, null); assert.equal(followed.live, false);
    assert(followed.frames.some(frame => frame.type === 'event' && JSON.stringify(frame.event) === JSON.stringify(tool)));
    await assert.rejects(send('resume', { sessionId: header.id }), /writer-held|lease|409/i);
    await other.json('DELETE', `/sessions/${header.id}/lease`, { leaseId: lease.leaseId });
    const resumed = await send('resume', { sessionId: header.id }); assert(resumed.seq > 2);
    assert.equal(resumed.teamService, true, 'Default Agent Teams host service is mounted');
    assert.deepEqual(resumed.teamTools, ['spawn_teammate', 'send_message', 'list_agents', 'team_task_create', 'team_task_list'], 'Default Agent Teams tools are available in the real Agent scope');
    const state = await send('state', { sessionId: header.id }); assert.equal(state.error, null); assert.equal(state.live, true);
    const before = (await api.json('GET', '/sessions')).sessions.length;
    await send('create'); await send('create');
    assert.equal((await api.json('GET', '/sessions')).sessions.length, before, 'Creating native blank Agents must not create cloud sessions');
    assert.equal(modelCalls, 0);
    t.diagnostic('Native full profile, exact cold snapshot, remote tool tail, lease refusal/resume and local blank creation verified.');
  } catch (error) {
    await writeFile(join(temporary, 'diagnostics.txt'), diagnostics);
    t.diagnostic(diagnostics); throw error;
  } finally {
    if (child.exitCode === null) {
      const stopped = once(child, 'exit'), timeout = setTimeout(() => child.kill(), 12000);
      child.send({ type: 'rufa:shutdown' }); await stopped; clearTimeout(timeout);
    }
    await bridge.stop(); await server.close(); await store.close();
  }
  assert.equal(flushed, true, 'Native lifecycle must finish with durable cache/cloud flush acknowledgement');
});
