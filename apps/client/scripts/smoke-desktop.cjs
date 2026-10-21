// Run with the installed development Electron binary, never with plain Node.
const { app, BrowserWindow, safeStorage } = require('electron');
const { createServer } = require('node:http');
const { mkdtemp, writeFile, readFile, access } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const showTestWindow = process.env.RUFA_TEST_SHOW_WINDOW === '1';
const captureHidden = contents => contents.capturePage(undefined, { stayHidden: true, stayAwake: true });
let cleanup = async () => {};
let reportDirectory;
let captureFailureState = async () => ({});
const timeout = setTimeout(() => { console.error('Desktop smoke timed out'); app.exit(1); }, 150_000);
async function until(predicate, message, count = 300) {
  for (let i = 0; i < count; i++) { if (await predicate()) return; await delay(50); }
  throw new Error(message);
}

void (async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'rufa-desktop-smoke-'));
  reportDirectory = temporary;
  const user = { id: 'mock-admin', username: 'admin', displayName: '测试管理', role: 'admin' };
  let keyConfigured = false, loginMode = 'ok';
  const loginBodies = [];
  const requests = []; const errors = [];
  const company = createServer(async (req, res) => {
    requests.push({ method: req.method, path: req.url }); let body = ''; for await (const chunk of req) body += chunk;
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/v1/auth/login') {
      loginBodies.push(JSON.parse(body));
      if (loginMode !== 'ok') { res.statusCode = loginMode === 'expired' ? 401 : 503; return res.end('{}'); }
      return res.end(JSON.stringify({ user, accessToken: 'desktop-mock-access', refreshToken: 'desktop-mock-refresh', deviceId: 'mock-device', expiresAt: new Date(Date.now() + 3600_000).toISOString() }));
    }
    if (req.headers.authorization !== 'Bearer desktop-mock-access') { res.statusCode = 401; return res.end('{}'); }
    if (req.url === '/api/v1/auth/me') return res.end(JSON.stringify({ user }));
    if (req.url === '/api/v1/auth/logout') { res.statusCode = 204; return res.end(); }
    if (req.url === '/api/v1/models') return res.end(JSON.stringify({ gatewayBasePath: '/api/v1/gateway/deepseek', models: [{ id: 'deepseek-flash', displayName: '测试模型', inputModalities: ['text', 'image'] }] }));
    if (req.url === '/api/v1/admin/users') return res.end(JSON.stringify({ users: [{ ...user, status: 'active', createdAt: new Date().toISOString() }] }));
    if (req.url === '/api/v1/admin/settings/deepseek') { if (req.method === 'PUT') keyConfigured = true; return res.end(JSON.stringify({ configured: keyConfigured, updatedAt: keyConfigured ? new Date().toISOString() : null })); }
    if (req.url.startsWith('/api/v1/sessions')) return res.end(JSON.stringify({ sessions: [] }));
    res.statusCode = 404; res.end('{}');
  });
  await new Promise(resolve => company.listen(0, '127.0.0.1', resolve));
  process.env.RUFA_TEST_SERVER_URL = `http://127.0.0.1:${company.address().port}`;
  process.env.RUFA_TEST_USER_DATA = join(temporary, 'profile');
  process.env.RUFA_TEST_HIDE_WINDOW = '1';
  process.env.RUFA_TEST_DIAGNOSTIC = '1';
  process.env.RUFA_UPSTREAM_ROOT = join(__dirname, '../runtime');
  app.on('web-contents-created', (_, contents) => {
    contents.setBackgroundThrottling(false);
    contents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  });
  await import(pathToFileURL(join(__dirname, '../dist/main.js')).href);
  let win; for (let attempt = 0; attempt < 200; attempt++) { win = BrowserWindow.getAllWindows()[0]; if (win && !win.webContents.isLoading() && win.webContents.getURL().endsWith('/renderer/index.html')) break; await delay(50); }
  assert.ok(win); const run = code => win.webContents.executeJavaScript(code);
  cleanup = () => run('window.rufa.call("logout")').catch(() => {});
  if (showTestWindow) win.showInactive();
  assert.equal(win.isVisible(), showTestWindow); await delay(300);
  const initial = await run('window.rufa.call("state")'); assert.equal(initial.ok, true); assert.equal(initial.value.user, null);
  await until(() => run('!document.getElementById("login-view").hidden'), 'Login form did not appear');
  assert.equal(await run('document.title'), 'Rufajx-DSH');
  assert.equal(await run('document.getElementById("server")'), null);
  assert.equal(await run('getComputedStyle(document.documentElement).backgroundColor'), 'rgb(17, 17, 17)');
  await writeFile(join(temporary, 'login.png'), (await captureHidden(win.webContents)).toPNG());
  await run('document.getElementById("username").value="admin"; document.getElementById("password").value="mock-only-password"; document.getElementById("remember-password").checked=true; document.getElementById("login-form").requestSubmit()');
  await until(() => run('!document.getElementById("loading-view").hidden'), 'Missing startup loading screen');
  await writeFile(join(temporary, 'loading.png'), (await captureHidden(win.webContents)).toPNG());
  await until(() => run('!document.getElementById("open-admin").disabled && document.getElementById("loading-view").hidden'), 'Original workbench did not finish loading', 1200);
  const signed = await run('window.rufa.call("state")'); assert.equal(signed.value.user.role, 'admin');
  const savedPath = join(process.env.RUFA_TEST_USER_DATA, 'remembered-login.enc');
  const cipher = await readFile(savedPath); assert.equal(cipher.includes(Buffer.from('mock-only-password')), false);
  assert.equal(JSON.parse(safeStorage.decryptString(cipher)).password, 'mock-only-password');
  const info = await run('window.rufa.call("login.saved")'); assert.deepEqual(info.value, { remembered: true, username: 'admin' });
  const web = win.contentView.children.find(child => child.webContents && child.webContents.id !== win.webContents.id);
  assert.ok(web);
  // Apply after native view creation/navigation, not only during web-contents-created.
  // Keep Chromium's real frame/visibility behavior; never stub requestAnimationFrame or fabricate DOM.
  web.webContents.setBackgroundThrottling(false);
  captureFailureState = async () => ({
    windowVisible: win.isVisible(), viewBounds: web.getBounds(),
    backgroundThrottling: web.webContents.getBackgroundThrottling(), rendererErrors: [...errors],
    page: await web.webContents.executeJavaScript(`({
      readyState: document.readyState, visibilityState: document.visibilityState, hidden: document.hidden,
      viewport: { width: innerWidth, height: innerHeight }, title: document.title,
      hasBootPage: !!document.querySelector('[data-dsh-boot]'),
      hasModuleLoader: !!window.__ModuleLoader__, rootChildren: document.getElementById('root')?.childElementCount ?? null,
      hasBrand: !!document.querySelector('[data-rufa-brand=name]'), bodyText: document.body.innerText.slice(0,2000)
    })`),
    animationFrame: await web.webContents.executeJavaScript(`new Promise(resolve => {
      const timer = setTimeout(() => resolve('timeout-500ms'), 500);
      requestAnimationFrame(() => { clearTimeout(timer); resolve('delivered'); });
    })`),
  });
  await writeFile(join(temporary, 'readiness-before.json'), JSON.stringify(await captureFailureState(), null, 2));
  // Request a real hidden capture before awaiting frame-dependent UI composition.
  // Failure stays diagnostic: brand presence is still required for a PASS.
  try { await writeFile(join(temporary, 'readiness.png'), (await captureHidden(web.webContents)).toPNG()); }
  catch (error) { await writeFile(join(temporary, 'capture-error.txt'), String(error.message)); }
  await until(() => web.webContents.executeJavaScript('!!document.querySelector("[data-rufa-brand=name]")'), 'Company brand is absent');
  const harnessText = await web.webContents.executeJavaScript('document.body.innerText.slice(0,3000)');
  assert.ok(harnessText.includes('Rufajx-DSH'));
  assert.equal(/DSH 本地构建|免责声明|预览版免责声明/.test(harnessText), false);
  assert.equal(await web.webContents.executeJavaScript('!!document.querySelector("[role=dialog][aria-modal=true]")'), false);
  assert.ok(web.webContents.getURL().startsWith('http://127.0.0.1:'));
  const viewport = await web.webContents.executeJavaScript('({width:innerWidth,height:innerHeight})'); assert.ok(viewport.width > 100 && viewport.height > 100);
  let harnessScreenshot = true;
  await delay(800);
  try { await writeFile(join(temporary, 'harness.png'), (await captureHidden(web.webContents)).toPNG()); }
  catch { harnessScreenshot = false; }
  await run('document.getElementById("open-admin").click()'); await delay(150);
  assert.equal(await run('document.getElementById("admin-view").hidden'), false);
  assert.ok((await run('document.getElementById("users").textContent')).includes('测试管理'));
  await run('document.getElementById("api-key").value="mock-key-not-real"; document.getElementById("key-form").requestSubmit()'); await delay(200);
  assert.equal(await run('document.getElementById("api-key").value'), ''); assert.equal(keyConfigured, true);
  assert.equal(await run('document.body.textContent.includes("mock-key-not-real")'), false);
  await writeFile(join(temporary, 'admin.png'), (await captureHidden(win.webContents)).toPNG());
  const loggedOut = await run('window.rufa.call("logout")'); assert.equal(loggedOut.ok, true); assert.equal(loggedOut.value.user, null); assert.equal(loggedOut.value.harness.message, undefined);
  await until(() => run('document.getElementById("password").placeholder === "已保存密码"'), 'Saved password hint missing');
  assert.equal(await run('document.getElementById("password").value'), '');
  loginMode = 'network';
  await run('document.getElementById("login-form").requestSubmit()');
  await until(() => run('!document.getElementById("login-view").hidden && !document.getElementById("notice").hidden'), 'Transient login failure not shown');
  assert.deepEqual(await readFile(savedPath), cipher);
  assert.equal(loginBodies.at(-1).password, 'mock-only-password');
  loginMode = 'expired';
  await run('document.getElementById("login-form").requestSubmit()');
  await until(() => run('document.getElementById("notice").textContent.includes("保存的密码已失效") && !document.getElementById("login-view").hidden'), 'Expired password did not recover to login form');
  await assert.rejects(access(savedPath), { code: 'ENOENT' });
  await until(() => run('document.getElementById("password").required && !document.getElementById("remember-password").checked'), 'Expired saved password still selected');
  loginMode = 'ok';
  await run('document.getElementById("password").value="mock-replacement-password"; document.getElementById("remember-password").checked=true; document.getElementById("login-form").requestSubmit()');
  await until(() => run('!document.getElementById("open-admin").disabled && document.getElementById("loading-view").hidden && document.getElementById("login-view").hidden'), 'Replacement login failed', 1200);
  assert.equal(JSON.parse(safeStorage.decryptString(await readFile(savedPath))).password, 'mock-replacement-password');
  await run('window.rufa.call("logout")');
  await until(() => run('document.getElementById("password").placeholder === "已保存密码"'), 'Replacement password hint missing');
  await run('document.getElementById("remember-password").click()');
  await until(async () => (await run('window.rufa.call("login.saved")')).value.remembered === false, 'Opt-out did not clear saved password');
  await assert.rejects(access(savedPath), { code: 'ENOENT' });
  await assert.rejects(access(`${savedPath}.pending`), { code: 'ENOENT' });
  assert.equal(await run('document.getElementById("password").required'), true);
  assert.equal(requests.filter(item => item.path.includes('/gateway/')).length, 0);
  assert.equal(win.isVisible(), showTestWindow); assert.deepEqual(errors, []);
  const report = { status: 'PASS', isolatedProfile: temporary, hiddenWindow: !showTestWindow, loginAndEncryptedVault: true, rememberedPassword: true, savedPasswordFailureAndOptOut: true, darkShell: true, adminPanel: true, originalHarnessWebView: true, companyBrand: true, noPreviewDisclaimer: true, gracefulLogout: true, paidModelCalls: 0, harnessScreenshot, viewport, companyRequests: requests, rendererErrors: errors, harnessText };
  await writeFile(join(temporary, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  clearTimeout(timeout); company.closeAllConnections(); company.close(); app.exit(0);
})().catch(async error => {
  let diagnostic;
  try { diagnostic = await captureFailureState(); } catch (probeError) { diagnostic = { probeError: String(probeError.message) }; }
  if (reportDirectory) await writeFile(join(reportDirectory, 'report.json'), JSON.stringify({ status: 'FAIL', message: error.message, stack: error.stack, diagnostic }, null, 2));
  console.error(error); await cleanup(); clearTimeout(timeout); app.exit(1);
});
