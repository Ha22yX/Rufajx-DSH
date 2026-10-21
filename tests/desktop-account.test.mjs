// Opt-in real Electron + real SQLite validation, completely separate from production accounts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
const serverModule = file => import(process.env.RUFA_TEST_SERVER_ROOT
  ? pathToFileURL(join(process.env.RUFA_TEST_SERVER_ROOT, 'dist', file)).href
  : new URL(`../apps/server/dist/${file}`, import.meta.url).href);
const { buildApp } = await serverModule('app.js');
const { configFromEnv } = await serverModule('config.js');
const { SqliteStore } = await serverModule('sqlite-store.js');
const { hashPassword } = await serverModule('security.js');

test('desktop account UI uses native settings and real authenticated profile/password endpoints', { skip: process.env.RUFA_DESKTOP_E2E !== '1', timeout: 150000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'rufa-desktop-account-'));
  const store = SqliteStore.open(join(temporary, 'company.sqlite'));
  const oldPassword = 'Desktop-fixture-only-123', newPassword = 'Desktop-new-fixture-456';
  await store.createUser({ username: 'desktop-test', displayName: '桌面验收', role: 'admin', passwordHash: await hashPassword(oldPassword) }, true);
  const server = buildApp(store, configFromEnv({}), () => store.ping());
  const endpoint = await server.listen({ host: '127.0.0.1', port: 0 });
  const adminLogin = await (await fetch(endpoint + '/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'desktop-test', password: oldPassword }) })).json();
  const adminHeaders = { authorization: `Bearer ${adminLogin.accessToken}`, 'content-type': 'application/json' };
  const recycled = await (await fetch(endpoint + '/api/v1/admin/users', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ username: 'recycle-desktop', displayName: '回收站验收', password: 'Abcde12345', role: 'employee' }) })).json();
  assert.equal((await fetch(endpoint + '/api/v1/admin/users/' + recycled.user.id, { method: 'DELETE', headers: { authorization: adminHeaders.authorization } })).status, 204);
  const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const clientRoot = resolve(process.env.RUFA_TEST_CLIENT_ROOT || 'apps/client');
  const env = { ...process.env, RUFA_TEST_USER_DATA: join(temporary, 'desktop-profile'), RUFA_TEST_SERVER_URL: endpoint,
    RUFA_TEST_HIDE_WINDOW: '1', RUFA_UPSTREAM_ROOT: process.env.RUFA_TEST_RUNTIME_ROOT || join(clientRoot, 'runtime') };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(resolve(process.env.RUFA_TEST_ELECTRON_PATH || 'node_modules/electron/dist/electron.exe'), [clientRoot, '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`, '--disable-background-timer-throttling', '--disable-renderer-backgrounding'], { env, windowsHide: true, stdio: 'ignore' });
  const sockets = [];
  async function until(fn, description, timeout = 30000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const value = await fn().catch(() => null); if (value) return value; await new Promise(resolve => setTimeout(resolve, 150)); }
    throw new Error(`Timed out: ${description}`);
  }
  async function connect(predicate) {
    const target = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(predicate), 'desktop target');
    const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise(resolve => ws.addEventListener('open', resolve, { once: true })); sockets.push(ws);
    let serial = 0; const pending = new Map();
    ws.addEventListener('message', event => { const result = JSON.parse(event.data); if (pending.has(result.id)) { const { resolve, reject, timer } = pending.get(result.id); pending.delete(result.id); clearTimeout(timer); result.error ? reject(new Error(result.error.message)) : resolve(result.result); } });
    ws.addEventListener('close', () => { for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error('Desktop view closed')); } pending.clear(); });
    const call = (method, params = {}) => new Promise((resolve, reject) => { const id = ++serial; const timer = setTimeout(() => { pending.delete(id); reject(new Error('Desktop command timed out')); }, 15000); pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params })); });
    const evaluate = async expression => { const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error('Desktop evaluation failed: ' + result.exceptionDetails.text); return result.result.value; };
    return { call, evaluate };
  }
  let shell;
  try {
    shell = await connect(target => target.type === 'page' && target.url.endsWith('/renderer/index.html'));
    await shell.call('Emulation.setFocusEmulationEnabled', { enabled: true });
    await until(() => shell.evaluate('window.rufa.call("state").then(r=>!r.value.booting)'), 'login ready');
    await shell.evaluate(`document.querySelector('#username').value='desktop-test';document.querySelector('#username').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#password').value=${JSON.stringify(oldPassword)};document.querySelector('#password').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#remember-password').checked=true;document.querySelector('#toggle-password').click();`);
    assert.equal(await shell.evaluate('document.querySelector("#password").type'), 'text');
    await shell.evaluate('document.querySelector("#toggle-password").click()');
    assert.equal(await shell.evaluate('document.querySelector("#password").type'), 'password');
    await shell.evaluate('document.querySelector("#login-form").requestSubmit()');
    await until(() => shell.evaluate('window.rufa.call("state").then(r=>r.value.harness.status==="running")'), 'workbench running', 60000);
    assert.equal(await shell.evaluate('window.rufa.call("login.saved").then(r=>r.value.remembered)'), true);
    const harness = await connect(target => target.type === 'page' && target.url.startsWith('http://127.0.0.1:'));
    await harness.call('Emulation.setFocusEmulationEnabled', { enabled: true });
    await until(() => harness.evaluate('Boolean(document.querySelector(".rufa-more-trigger"))'), 'more menu');
    await harness.evaluate('document.querySelector(".rufa-more-trigger").click()');
    await until(() => harness.evaluate('[...document.querySelectorAll("[role=menuitem]")].some(e=>e.textContent.includes("设置"))'), 'settings item');
    await harness.evaluate('[...document.querySelectorAll("[role=menuitem]")].find(e=>e.textContent.includes("设置")).click()');
    await until(() => harness.evaluate('Boolean(document.querySelector("#rufa-display-name"))'), 'account settings');
    assert.equal(await harness.evaluate('[...document.querySelectorAll("button")].some(e=>e.textContent.includes("打开配置文件"))'), false);
    assert.equal(await harness.evaluate('Boolean(document.querySelector("[data-shortcut-modal=settings] button[class$=_close]"))'), true);
    assert.equal(await harness.evaluate('[...document.querySelectorAll("button")].some(e=>["仅可查看","工作区内修改","完全权限","自动审查"].includes(e.textContent.trim()))'), false);
    assert.equal(await harness.evaluate('document.querySelector("#rufa-job-title").value'), '');
    const capture = await harness.call('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(temporary, 'account-info.png'), Buffer.from(capture.data, 'base64'));
    const set = async (selector, value) => harness.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await set('#rufa-display-name', '更新的测试姓名'); await set('#rufa-job-title', '项目主管');
    await harness.evaluate('document.querySelector("#rufa-display-name").closest("form").requestSubmit()');
    await until(() => harness.evaluate('document.querySelector("[data-rufa-account-details]").textContent.includes("资料已保存")'), 'profile saved');
    assert.equal(await shell.evaluate('window.rufa.call("state").then(r=>r.value.user.jobTitle)'), '项目主管');
    await shell.evaluate('document.querySelector("#open-admin").click()');
    await shell.evaluate('document.querySelector("#admin-nav [data-section=accounts]").click()');
    await until(() => shell.evaluate('!document.querySelector("#admin-view").hidden && document.querySelector("#users").textContent.includes("desktop-test")'), 'admin account list');
    await shell.evaluate('document.querySelector("#new-account").click()');
    await until(() => shell.evaluate('Boolean(document.querySelector("#account-form"))'), 'create account dialog');
    await shell.evaluate(`(()=>{for(const [id,value] of Object.entries({'account-username':'desktop-job','account-display-name':'职位创建验收','account-job-title':'研发','account-password':'Abcde12345'})) document.getElementById(id).value=value; document.querySelector('#account-form').requestSubmit();})()`);
    await until(() => shell.evaluate('document.querySelector("#users").textContent.includes("desktop-job")'), 'account with job title created');
    await until(() => shell.evaluate('Boolean(document.querySelector("dialog[open] .credential"))'), 'initial password delivered after successful creation');
    await shell.evaluate('document.querySelector("dialog[open] form").requestSubmit()');
    assert.equal(await shell.evaluate('document.querySelector("#users").textContent.includes("研发")'), true);
    const jobUsers = await (await fetch(endpoint + '/api/v1/admin/users', { headers: adminHeaders })).json();
    assert.equal(jobUsers.users.find(user=>user.username==='desktop-job').jobTitle, '研发');
    assert.equal(await shell.evaluate('document.querySelector("#users").textContent.includes("recycle-desktop")'), false);
    await shell.evaluate('document.querySelector("#show-recycled-users").click()');
    await until(() => shell.evaluate('document.querySelector("#users").textContent.includes("恢复账号")'), 'recycle bin');
    const recycleCapture = await shell.call('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(temporary, 'recycle-bin.png'), Buffer.from(recycleCapture.data, 'base64'));
    await shell.evaluate('[...document.querySelectorAll("#users button")].find(e=>e.textContent==="恢复账号").click()');
    await until(() => shell.evaluate('Boolean(document.querySelector("dialog[open]"))'), 'restore confirmation');
    await shell.evaluate('document.querySelector("dialog[open] form").requestSubmit()');
    await until(() => shell.evaluate('!document.querySelector("#users").textContent.includes("recycle-desktop")'), 'account restored');
    await shell.evaluate('document.querySelector("#show-active-users").click()');
    await until(() => shell.evaluate('document.querySelector("#users").textContent.includes("recycle-desktop")'), 'restored account appears');
    await shell.evaluate('document.querySelector("#open-harness").click()');
    const passwordSubmit = async current => { await set('#rufa-currentPassword', current); await set('#rufa-newPassword', newPassword); await set('#rufa-confirmPassword', newPassword); await harness.evaluate('document.querySelector("#rufa-currentPassword").closest("form").requestSubmit()'); };
    await passwordSubmit('incorrect-fixture-password');
    await until(() => harness.evaluate('document.querySelector("[data-rufa-account-details]").textContent.includes("原密码不正确")'), 'incorrect password rejected');
    assert.equal(await shell.evaluate('window.rufa.call("state").then(r=>Boolean(r.value.user))'), true);
    await passwordSubmit(oldPassword);
    await until(() => shell.evaluate('window.rufa.call("state").then(r=>!r.value.user && r.value.loginNotice.includes("密码已修改"))'), 'password changed and logged out');
    assert.equal(await shell.evaluate('window.rufa.call("login.saved").then(r=>r.value.remembered)'), false);
    const denied = await fetch(endpoint + '/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'desktop-test', password: oldPassword }) });
    assert.equal(denied.status, 401); await denied.arrayBuffer();
    const accepted = await fetch(endpoint + '/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'desktop-test', password: newPassword }) });
    assert.equal(accepted.status, 200); const saved = await accepted.json();
    assert.equal(saved.user.displayName, '更新的测试姓名'); assert.equal(saved.user.jobTitle, '项目主管');
    t.diagnostic(`Real Electron + SQLite profile/password flow verified without production credentials or model requests. Screenshot: ${join(temporary, 'account-info.png')}`);
  } finally {
    if (shell) await shell.evaluate('window.close()').catch(() => {});
    for (const ws of sockets) ws.close();
    if (child.exitCode === null) { const exited = once(child, 'exit'); const timer = setTimeout(() => child.kill(), 15000); await exited; clearTimeout(timer); }
    await server.close(); await store.close();
  }
});
