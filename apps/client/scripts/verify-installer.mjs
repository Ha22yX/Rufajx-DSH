import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { verifyPackagedPreinstalled } from '../../../scripts/verify-packaged-preinstalled.mjs';

const [installerInput, sevenZipInput, credentialFile] = process.argv.slice(2);
if (!installerInput || !sevenZipInput) throw new Error('Usage: node verify-installer.mjs <installer.exe> <7z.exe>');
const installer = resolve(installerInput); const sevenZip = resolve(sevenZipInput);
const temporary = await mkdtemp(join(tmpdir(), 'rufa-installer-test-'));
const outer = join(temporary, 'installer'); let extracted = join(temporary, 'application');
execFileSync(sevenZip, ['x', '-y', `-o${outer}`, installer], { stdio: 'pipe', windowsHide: true });
try { await access(join(outer, 'resources/company-config.json')); extracted = outer; }
catch { execFileSync(sevenZip, ['x', '-y', `-o${extracted}`, join(outer, '$PLUGINSDIR', 'app-64.7z')], { stdio: 'pipe', windowsHide: true }); }
const resources = join(extracted, 'resources');
await verifyPackagedPreinstalled(resources);
const config = JSON.parse(await readFile(join(resources, 'company-config.json'), 'utf8'));
assert.deepEqual(config, { mode: 'production', serverUrl: 'https://dsh.example.com' });
const runtime = JSON.parse(await readFile(join(resources, 'harness/rufa-runtime.json'), 'utf8'));
assert.equal(runtime.upstreamCommit, '687f282e8625c6b8d11ff58211a90524be2e4317');
await access(join(resources, 'harness', runtime.cli));
for (const file of ['company-model.mjs', 'company-web.mjs', 'managed-credentials.mjs', 'remote-persistence.mjs', 'import-upstream.mjs']) await access(join(resources, 'company-plugins', file));
const node = join(resources, 'node/node.exe'); const nodeManifest = JSON.parse(await readFile(join(resources, 'node/node-runtime.json'), 'utf8'));
assert.equal(createHash('sha256').update(await readFile(node)).digest('hex'), nodeManifest.sha256);
assert.equal(execFileSync(node, ['--version'], { encoding: 'utf8', windowsHide: true }).trim(), 'v24.16.0');
const runtimeSmoke = execFileSync(node, [fileURLToPath(new URL('./smoke-runtime.mjs', import.meta.url)), join(resources, 'harness'), join(resources, 'company-plugins')], { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
assert.ok(runtimeSmoke.includes('persistence acknowledgement'), 'Extracted Node + runtime + actual packaged plugins must start and stop without upstream source');
const reserve = createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve)); const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(join(extracted, '如发机械 DSH.exe'), [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'], { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
let diagnostic = ''; child.stderr.on('data', data => { diagnostic = (diagnostic + data).slice(-4000); });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket;
let cloudCleanup;
try {
  let target;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.type === 'page' && item.url.endsWith('/renderer/index.html')); } catch {}
    if (target) break; if (child.exitCode !== null) throw new Error(`Packaged app exited: ${child.exitCode}`); await delay(100);
  }
  assert.ok(target, 'Packaged production application must open its actual renderer');
  socket = new WebSocket(target.webSocketDebuggerUrl); await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let ordinal = 0; const pending = new Map();
  socket.addEventListener('message', event => { const value = JSON.parse(event.data); if (value.id) { const done = pending.get(value.id); pending.delete(value.id); value.error ? done?.reject(new Error(value.error.message)) : done?.resolve(value.result); } });
  const cdp = (method, params) => new Promise((resolve, reject) => { const id = ++ordinal; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  let ready;
  for (let attempt = 0; attempt < 100; attempt++) {
    ready = await cdp('Runtime.evaluate', { expression: 'document.readyState === "complete" && typeof window.rufa?.call === "function"', returnByValue: true });
    if (ready.result.value === true) break;
    await delay(100);
  }
  assert.equal(ready.result.value, true, 'Packaged preload and renderer must finish loading');
  const evaluated = await cdp('Runtime.evaluate', { expression: '(async()=>({state:await window.rufa.call("state"),loginVisible:!document.getElementById("login-view").hidden,serverFieldHidden:document.getElementById("server-label").hidden}))()', awaitPromise: true, returnByValue: true });
  if (!evaluated.result?.value?.state) throw new Error(`Packaged renderer evaluation failed: ${JSON.stringify(evaluated)}`);
  const facts = evaluated.result.value;
  assert.equal(facts.state.ok, true); assert.equal(facts.state.value.companyServer, config.serverUrl); assert.equal(facts.state.value.development, false); assert.equal(facts.state.value.testBuild, false);
  assert.equal(facts.state.value.user, null); assert.equal(facts.loginVisible, true); assert.equal(facts.serverFieldHidden, true);
  const screenshot = await cdp('Page.captureScreenshot', { format: 'png' }); await writeFile(join(temporary, 'packaged-login.png'), Buffer.from(screenshot.data, 'base64'));
  let cloudReadOnlyVerification = false;
  if (credentialFile) {
    // Explicitly provided private credential file; never print, screenshot,
    // persist in reports, or send these values outside the configured company.
    let privateText = await readFile(credentialFile, 'utf8');
    const username = privateText.match(/^(?:username|user|账号|用户名)\s*[:=：]\s*(.+)$/im)?.[1]?.trim();
    let password = privateText.match(/^(?:password|密码|初始密码)\s*[:=：]\s*(.+)$/im)?.[1]?.trim();
    privateText = '';
    assert.ok(username && password, 'Private file must contain labelled username and password');
    cloudCleanup = () => cdp('Runtime.evaluate', { expression: 'window.rufa.call("logout")', awaitPromise: true, returnByValue: true });
    const login = await cdp('Runtime.evaluate', { expression: `window.rufa.call('login',${JSON.stringify({ username, password })})`, awaitPromise: true, returnByValue: true }); password = '';
    assert.equal(login.result.value?.ok, true, 'Production cloud login must succeed');
    assert.equal(login.result.value?.value?.user?.role, 'admin');
    const users = await cdp('Runtime.evaluate', { expression: 'window.rufa.call("admin.users")', awaitPromise: true, returnByValue: true }); assert.equal(users.result.value?.ok, true);
    const settings = await cdp('Runtime.evaluate', { expression: 'window.rufa.call("admin.deepseekStatus")', awaitPromise: true, returnByValue: true }); assert.equal(settings.result.value?.ok, true);
    assert.deepEqual(Object.keys(settings.result.value.value).sort(), ['configured', 'updatedAt']);
    const logout = await cdp('Runtime.evaluate', { expression: 'window.rufa.call("logout")', awaitPromise: true, returnByValue: true }); assert.equal(logout.result.value?.ok, true); assert.equal(logout.result.value?.value?.user, null);
    cloudCleanup = undefined;
    cloudReadOnlyVerification = true;
  }
  const exit = new Promise(resolve => child.once('exit', resolve));
  void cdp('Runtime.evaluate', { expression: 'window.close()' }).catch(() => {});
  const code = await Promise.race([exit, delay(10_000).then(() => 'timeout')]); assert.equal(code, 0, 'Packaged application must close normally');
  const report = { status: 'PASS', installer, sha256: createHash('sha256').update(await readFile(installer)).digest('hex'), extracted, productionServer: config.serverUrl, originalRuntimeCommit: runtime.upstreamCommit, nodeVersion: nodeManifest.version, nodeOfficialSha256: nodeManifest.sha256, extractedFullRuntimeStartedAndFlushed: true, actualProductionExeStarted: true, loginViewVerified: true, customServerHidden: true, cloudReadOnlyVerification, paidModelCalls: 0 };
  await writeFile(join(temporary, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} catch (error) { console.error(diagnostic); throw error; }
finally { if (cloudCleanup) await cloudCleanup().catch(() => {}); socket?.close(); if (child.exitCode === null) child.kill(); }
