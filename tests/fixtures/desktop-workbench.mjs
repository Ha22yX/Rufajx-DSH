// Isolated real Electron/native Harness fixture. All model requests stop locally.
import { access, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
const serverRoot = process.env.RUFA_TEST_SERVER_ROOT;
const serverModule = file => import(serverRoot ? pathToFileURL(join(serverRoot, 'dist', file)).href : new URL(`../../apps/server/dist/${file}`, import.meta.url).href);
const { buildApp } = await serverModule('app.js');
const { configFromEnv } = await serverModule('config.js');
const { SqliteStore } = await serverModule('sqlite-store.js');
const { hashPassword } = await serverModule('security.js');
const clientModule = file => import(process.env.RUFA_TEST_CLIENT_ROOT
  ? pathToFileURL(join(process.env.RUFA_TEST_CLIENT_ROOT, 'dist', file)).href
  : new URL(`../../apps/client/dist/${file}`, import.meta.url).href);
const { CompanyApi } = await clientModule('company-api.js');
const { accountRuntimePaths } = await clientModule('runtime-configuration.js');
import { installNativeDirectoryPickerFixture } from './native-directory-picker.mjs';

export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function until(fn, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try { const value = await fn(); if (value) return value; } catch (error) { lastError = error; }
    await pause(100);
  }
  throw new Error(`Timed out: ${label}${lastError ? ` (${lastError.message})` : ''}`);
}

export async function startWorkbenchFixture(t, { prefix = 'rufa-projects-', seed, nativeDirectoryPicker = false, captureGatewayBodies = false, role = 'admin', visibleWindow = false, configureServer } = {}) {
  const temporary = await mkdtemp(join(tmpdir(), prefix));
  const store = SqliteStore.open(join(temporary, 'company.sqlite'));
  const password = 'Synthetic-projects-2026';
  const user = await store.createUser({ username: 'projects-test', displayName: '项目验收', role, passwordHash: await hashPassword(password) }, true);
  const server = buildApp(store, configFromEnv({}), () => store.ping());
  await configureServer?.(server);
  let gatewayCalls = 0;
  const gatewayRequests = [];
  server.addHook('onRequest', async (request, reply) => {
    if (request.url.includes('/gateway/')) {
      gatewayCalls++;
      if (!captureGatewayBodies) reply.code(400).send({ error: { code: 'FIXTURE_ONLY', message: 'Synthetic model refusal' } });
    }
  });
  if (captureGatewayBodies) server.addHook('preValidation', async (request, reply) => {
    if (!request.url.includes('/gateway/')) return;
    gatewayRequests.push(request.body);
    reply.code(400).send({ error: { code: 'FIXTURE_ONLY', message: 'Synthetic model refusal' } });
  });
  const endpoint = await server.listen({ host: '127.0.0.1', port: 0 });
  const api = new CompanyApi({ read: async () => null, write: async () => {}, clear: async () => {} }, true);
  await api.login(endpoint, 'projects-test', password);
  const profile = join(temporary, 'desktop-profile');
  const account = accountRuntimePaths(join(profile, 'accounts'), endpoint, user.id);
  await mkdir(account.workspaceRoot, { recursive: true });
  if (seed) await seed({ api, account, temporary });
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const clientRoot = resolve(process.env.RUFA_TEST_CLIENT_ROOT || 'apps/client');
  // Real animation assertions need a presented window: Windows can suspend
  // compositor frames in a hidden Electron even with timer throttling disabled.
  const env = { ...process.env, RUFA_TEST_USER_DATA: profile, RUFA_TEST_SERVER_URL: endpoint, RUFA_TEST_HIDE_WINDOW: visibleWindow ? '0' : '1', RUFA_TEST_DIAGNOSTIC: '1', RUFA_UPSTREAM_ROOT: process.env.RUFA_TEST_RUNTIME_ROOT || join(clientRoot, 'runtime') };
  delete env.ELECTRON_RUN_AS_NODE;
  const directoryPicker = nativeDirectoryPicker ? await installNativeDirectoryPickerFixture(process.env.RUFA_TEST_RUNTIME_ROOT, temporary) : undefined;
  const sockets = [];
  let child, shell, harness;
  async function connect(predicate) {
    const target = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(predicate), 'desktop page');
    const ws = new WebSocket(target.webSocketDebuggerUrl); sockets.push(ws);
    await once(ws, 'open');
    let serial = 0;
    const pending = new Map(), errors = [];
    ws.addEventListener('message', event => {
      const value = JSON.parse(event.data), waiter = pending.get(value.id);
      if (value.method === 'Runtime.exceptionThrown' || value.method === 'Log.entryAdded') errors.push(value.params);
      if (value.method === 'Runtime.consoleAPICalled' && ['error', 'warning', 'warn'].includes(value.params.type)) errors.push(value.params);
      if (!waiter) return;
      pending.delete(value.id); clearTimeout(waiter.timer);
      value.error ? waiter.reject(new Error(value.error.message)) : waiter.resolve(value.result);
    });
    const call = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout ${method}`)); }, 10000);
      pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async expression => {
      const value = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (value.exceptionDetails) throw new Error(JSON.stringify(value.exceptionDetails));
      return value.result.value;
    };
    await call('Runtime.enable'); await call('Log.enable');
    return { call, evaluate, errors };
  }
  async function stopDesktop() {
    if (shell) await shell.evaluate('window.close()').catch(() => {});
    await Promise.all(sockets.splice(0).map(ws => new Promise(resolve => {
      if (ws.readyState === WebSocket.CLOSED) return resolve();
      const timer = setTimeout(resolve, 1000);
      ws.addEventListener('close', () => { clearTimeout(timer); resolve(); }, { once: true }); ws.close();
    })));
    if (child?.exitCode === null) {
      const ended = once(child, 'exit'), timer = setTimeout(() => child.kill(), 12000);
      await ended; clearTimeout(timer);
    }
    child = shell = harness = undefined;
  }
  async function launchDesktop() {
    let runtimeDiagnostics = '';
    const electronPath = resolve(process.env.RUFA_TEST_ELECTRON_PATH || 'node_modules/electron/dist/electron.exe');
    await access(electronPath);
    child = spawn(electronPath, [clientRoot, '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`,
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-background-media-suspend'], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', chunk => { runtimeDiagnostics = (runtimeDiagnostics + chunk).slice(-48000); });
    shell = await connect(target => target.type === 'page' && target.url.endsWith('/renderer/index.html'));
    // Main-process boot completion may precede the renderer's login form.
    // Wait for a renderable signed-in or signed-out state before deciding.
    await until(() => shell.evaluate('window.rufa.call("state").then(r=>!r.value.booting&&(Boolean(r.value.user)||Boolean(document.querySelector("#login-form")?.getBoundingClientRect().height)))'), 'login ready');
    if (await shell.evaluate('window.rufa.call("state").then(r=>!r.value.user&&Boolean(document.querySelector("#login-form")?.getBoundingClientRect().height))')) {
      await shell.evaluate(`document.querySelector('#username').value='projects-test';document.querySelector('#username').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#password').value=${JSON.stringify(password)};document.querySelector('#password').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#login-form').requestSubmit();`);
    }
    try {
      const status = await until(() => shell.evaluate('window.rufa.call("state").then(r=>["running","failed"].includes(r.value.harness.status)&&r.value.harness.status)'), 'Harness running', 60000);
      if (status !== 'running') throw new Error('Synthetic Harness failed to start');
    }
    catch (error) {
      await writeFile(join(temporary, 'runtime-diagnostics.txt'), runtimeDiagnostics);
      t.diagnostic(await shell.evaluate('window.rufa.call("state").then(r=>JSON.stringify({booting:r.value.booting,signedIn:Boolean(r.value.user),harnessStatus:r.value.harness.status,message:r.value.harness.message,text:document.body.innerText}))').catch(() => 'Desktop shell unavailable'));
      throw error;
    }
    harness = await connect(target => target.type === 'page' && target.url.startsWith('http://127.0.0.1:'));
    await harness.call('Emulation.setFocusEmulationEnabled', { enabled: true });
    try { await until(() => harness.evaluate('document.documentElement.dataset.rufaStartup==="ready"'), 'startup ready'); }
    catch (error) {
      t.diagnostic(`Startup artifacts: ${temporary}`);
      await writeFile(join(temporary, 'startup-diagnostics.json'), JSON.stringify({ runtime: runtimeDiagnostics, errors: harness.errors }, null, 2));
      t.diagnostic(JSON.stringify(harness.errors.map(error => error.args ? error.args.map(arg => (arg.value ?? arg.description ?? arg.type)?.toString().split('\n')[0]).join(' ') : error.exceptionDetails?.exception?.description?.split('\n')[0] ?? error.entry?.text)));
      t.diagnostic(await harness.evaluate('JSON.stringify({text:document.body.innerText,root:document.getElementById("root")?.textContent?.slice(-8000),buttons:[...document.querySelectorAll("button")].map(e=>({text:e.textContent,label:e.getAttribute("aria-label")}))})'));
      throw error;
    }
    return harness;
  }
  const cache = () => {
    const db = new DatabaseSync(join(account.companyHome, 'company-history.sqlite'), { readOnly: true });
    try { return db.prepare('SELECT id,header,cloud_state FROM sessions ORDER BY json_extract(header,\'$.createdAt\')').all().map(row => ({ id: row.id, header: JSON.parse(row.header), cloudState: row.cloud_state })); }
    finally { db.close(); }
  };
  t.after(async () => {
    try { await stopDesktop(); }
    finally {
      try { await directoryPicker?.restore(); }
      finally { await api.logout().catch(() => {}); await server.close(); await store.close(); }
    }
  });
  const capture = async name => {
    const image = await harness.call('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(temporary, `${name}.png`), Buffer.from(image.data, 'base64'));
  };
  await launchDesktop();
  return { temporary, account, endpoint, user, api, cache, capture, directoryPicker, gatewayRequests, get harness() { return harness; }, get shell() { return shell; }, get gatewayCalls() { return gatewayCalls; },
    restart: async () => { await stopDesktop(); return launchDesktop(); } };
}
