// Test-only packaged entry. Never added to the production archive.
const { app, BrowserWindow, session, net, dialog } = require('electron');
const { readFileSync, mkdirSync, writeFileSync, existsSync } = require('node:fs');
const { join, resolve, relative, isAbsolute } = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const argument = process.argv.find(value => value.startsWith('--rufa-acceptance-config='));
if (!argument) { app.exit(2); throw new Error('Explicit acceptance configuration required'); }
const config = JSON.parse(readFileSync(argument.slice('--rufa-acceptance-config='.length), 'utf8'));
const inside = (root, path) => {
  const sub = relative(resolve(root), resolve(path));
  return !!sub && !sub.startsWith('..') && !isAbsolute(sub);
};
assert.match(config.root, /[\\/]rufa-packaged-startup-[^\\/]+$/);
for (const path of [config.output, ...Object.values(config.paths)]) assert.ok(inside(config.root, path));
assert.ok(!inside(config.root, config.archive), 'Final archive must be separate from the bootstrap');
const report = {
  passed: false, scope: 'Final app.asar imported unchanged by isolated packaged bootstrap; not actual NSIS/installed entry',
  scenario: config.scenario, runtimeKind: config.runtimeKind, packaged: app.isPackaged,
  electron: process.versions.electron, actualPublicRequests: 0, simulatedResponses: 0, blockedRequests: [],
  phases: [], screenshots: [], rendererErrors: [], companyRequests: 0,
};
let finished = false, window, releaseRequest, watchdog;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function save() { writeFileSync(join(config.output, 'report.json'), JSON.stringify(report, null, 2)); }
function end(error) {
  if (finished) return;
  finished = true; clearTimeout(watchdog);
  report.passed = !error;
  if (error) report.error = String(error.stack || error);
  save();
  for (const item of BrowserWindow.getAllWindows()) item.destroy();
  app.exit(error ? 1 : 0);
}
process.on('uncaughtException', end);
process.on('unhandledRejection', end);
// All paths are set before importing main or constructing Chromium sessions.
for (const [name, path] of Object.entries({
  appData: config.paths.appData, userData: config.paths.initialUserData, sessionData: config.paths.sessionData,
  crashDumps: config.paths.crashDumps, temp: config.paths.temp,
})) { mkdirSync(path, { recursive: true }); app.setPath(name, path); }
app.setAppLogsPath(config.paths.logs);
assert.equal(resolve(process.env.LOCALAPPDATA), resolve(config.paths.localAppData));
assert.equal(resolve(process.env.APPDATA), resolve(config.paths.appData));
assert.equal(app.isPackaged, true, 'Native executable must report packaged without overriding it');
Object.defineProperty(process, 'resourcesPath', { value: config.resources });
app.setAppPath(config.archive);
const manifest = JSON.parse(readFileSync(join(config.archive, 'package.json'), 'utf8'));
assert.equal(manifest.name, '@rufa/client');
assert.equal(manifest.version, config.versionFromFinalArchive);
assert.equal(app.getVersion(), manifest.version, 'Bootstrap version must be copied from final app.asar manifest');
assert.equal(manifest.main, 'dist/main.js');
report.versionFromFinalArchive = manifest.version;
const sha = value => createHash('sha256').update(value).digest('hex');
report.mainHash = sha(readFileSync(join(config.archive, manifest.main)));
report.preloadHash = sha(readFileSync(join(config.archive, 'dist/preload.cjs')));
// A startup failure must become a report rather than block in an unattended box.
dialog.showErrorBox = () => end(new Error('Production startup reported failure'));
// The real Node fetch is captured only for the explicit read-only public case.
// Every production fetch is guarded below before the final module is imported.
const publicFetch = globalThis.fetch;
app.on('browser-window-created', (_event, item) => {
  item.setFocusable(false); item.setSkipTaskbar(true);
  item.webContents.on('console-message', (_event, ...args) => {
    // Electron versions differ in console event shape; record only error count.
    const level = typeof args[0] === 'object' ? args[0].level : args[0];
    if (level === 'error' || level === 3) report.rendererErrors.push('renderer console error');
  });
  item.webContents.on('render-process-gone', () => end(new Error('Renderer exited unexpectedly')));
  window = item;
});
watchdog = setTimeout(() => end(new Error('Isolated startup timed out')), 50_000);
async function until(test, label, limit = 25_000) {
  const deadline = Date.now() + limit;
  while (Date.now() < deadline) {
    if (finished) throw new Error('Fixture already ended');
    if (await test()) return;
    await pause(25);
  }
  throw new Error(`Timeout: ${label}`);
}
async function state() {
  const value = await window.webContents.executeJavaScript(`(async()=>{
    const result=await window.rufa.call('state');
    if(!result.ok)throw new Error('State unavailable');
    const s=result.value;
    return {development:s.development,version:s.version,booting:s.booting,hasUser:!!s.user,
      companyServer:s.companyServer,harness:s.harness.status,phase:s.update?.phase};
  })()`);
  assert.equal(value.development, false);
  assert.equal(value.version, manifest.version);
  assert.equal(value.companyServer, 'https://dsh.example.com');
  assert.equal(value.hasUser, false);
  assert.equal(value.harness, 'stopped');
  if (report.phases.at(-1) !== value.phase) report.phases.push(value.phase);
  return value;
}
async function shot(name) {
  await pause(380);
  const image = await window.webContents.debugger.sendCommand('Page.captureScreenshot', {
    format: 'png', fromSurface: true, captureBeyondViewport: false,
  });
  writeFileSync(join(config.output, name + '.png'), Buffer.from(image.data, 'base64'));
  report.screenshots.push(name + '.png');
}
async function main() {
  await app.whenReady();
  const feed = 'https://dsh.example.com/api/v1/client-updates/windows/x64/incremental/latest.json';
  const deferredRequest = new Promise(resolve => { releaseRequest = resolve; });
  const updaterSession = session.fromPartition('electron-updater', { cache: false });
  const reject = request => {
    const parsed = new URL(request.url);
    report.blockedRequests.push({ protocol: parsed.protocol, host: parsed.host, path: parsed.pathname });
    return new Response('Blocked by isolated acceptance harness', { status: 403 });
  };
  await session.defaultSession.protocol.handle('https', reject);
  await session.defaultSession.protocol.handle('http', reject);
  await updaterSession.protocol.handle('http', reject);
  let requests = 0;
  await updaterSession.protocol.handle('https', reject);
  globalThis.fetch = async (input, options = {}) => {
    const request = new Request(input, options);
    const url = new URL(request.url);
    if (url.href !== feed || request.method !== 'GET') { report.companyRequests++; return reject(request); }
    for (const name of ['authorization', 'proxy-authorization', 'cookie', 'x-api-key']) {
      assert.equal(request.headers.has(name), false, 'Public update request must have no credentials');
    }
    requests++;
    await deferredRequest;
    if (config.scenario === 'unavailable') {
      report.simulatedResponses++;
      return new Response('Synthetic service unavailable', { status: 503 });
    }
    if (config.scenario === 'equal') {
      report.simulatedResponses++;
      const filename = `releases/${manifest.version}/Rufa-DSH-${manifest.version}-x64-Setup.exe`;
      const hash = createHash('sha512').update('not an installer').digest('base64');
      return Response.json({ schema: 1, version: manifest.version, releaseDate: '2026-10-21T00:00:00.000Z', minUpdaterVersion: '0.3.0',
        manifest: { url: `releases/${manifest.version}/incremental-manifest.json`, size: 16, sha512: hash,
          keyId: 'a'.repeat(64), algorithm: 'rsa-sha256', signature: Buffer.alloc(384).toString('base64') },
        installer: { url: filename, sha512: hash, size: 16 } });
    }
    assert.equal(config.scenario, 'public');
    report.actualPublicRequests++;
    // The session protocol guard sees the real updater URL. Only this read-only
    // request bypasses the custom handler; redirects never leave the fixed feed.
    const response = await publicFetch(request.url, {
      method: 'GET', redirect: 'error', credentials: 'omit', signal: options.signal,
    });
    report.publicStatus = response.status;
    assert.equal(response.status, 200, 'Published equal-version feed must exist');
    const text = await response.text();
    assert.ok(text.length < 65_536);
    const metadata = JSON.parse(text);
    report.publicVersion = metadata.version;
    assert.equal(metadata.version, manifest.version, 'Only equal-version public acceptance is allowed; refuse installer download');
    return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await import(pathToFileURL(join(config.archive, manifest.main)).href);
  assert.equal(resolve(app.getPath('userData')), resolve(join(config.paths.appData, 'RufaDSH')));
  assert.equal(resolve(app.getPath('sessionData')), resolve(config.paths.sessionData));
  assert.equal(existsSync(config.paths.ignoredTestProfile), false, 'Packaged code must ignore RUFA_TEST_USER_DATA');
  report.isolatedPaths = {
    appData: app.getPath('appData'), userData: app.getPath('userData'), sessionData: app.getPath('sessionData'),
    localAppData: process.env.LOCALAPPDATA, logs: app.getPath('logs'), crashDumps: app.getPath('crashDumps'),
  };
  for (const path of Object.values(report.isolatedPaths)) assert.ok(inside(config.root, path));
  await until(async () => window && !window.webContents.isLoading()
    && await window.webContents.executeJavaScript("typeof window.rufa?.call === 'function'"), 'production renderer');
  window.webContents.debugger.attach('1.3');
  await until(async () => (await state()).phase === 'checking', 'checking');
  assert.equal((await state()).booting, true);
  await shot('checking');
  releaseRequest();
  if (config.scenario === 'unavailable') {
    await until(async () => (await state()).phase === 'error', 'simulated 503 recovery');
    await shot('unavailable');
    await window.webContents.executeJavaScript("document.querySelector('#update-retry').click();document.querySelector('#update-retry').click()");
    await until(async () => requests === 2 && (await state()).phase === 'error', 'single retry');
    await shot('retry-error');
    await window.webContents.executeJavaScript("document.querySelector('#update-continue').click()");
  }
  await until(async () => !(await state()).booting, 'login admitted');
  const final = await state();
  assert.equal(final.phase, config.scenario === 'unavailable' ? 'skipped' : 'current');
  assert.equal(await window.webContents.executeJavaScript("!document.querySelector('#login-view').hidden"), true);
  await shot('login');
  const denied = await window.webContents.executeJavaScript("window.rufa.call('update.retry')");
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'UPDATE_CLOSED');
  assert.equal(report.companyRequests, 0);
  assert.equal(report.blockedRequests.length, 0, 'No installer, authentication or other network request was attempted');
  assert.equal(report.rendererErrors.length, 0);
  assert.equal(existsSync(join(app.getPath('userData'), 'login.enc')), false);
  assert.equal(existsSync(join(app.getPath('userData'), 'remembered-login.enc')), false);
  report.requests = requests;
  report.fixtureAlterations = ['Unique TEMP appData/sessionData/LOCALAPPDATA', 'bootstrap resourcesPath/appPath to original package',
    'test-only guarded Node fetch and Chromium protocol handlers', 'window nonfocusable', 'error dialog converted to failure report'];
  report.final = final;
  end();
}
main().catch(end);
