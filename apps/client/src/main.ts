import { app, BrowserWindow, WebContentsView, ipcMain, safeStorage, dialog, shell, nativeTheme } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { realpathSync } from 'node:fs';
import { CompanyApi } from './company-api.js';
import { EncryptedCredentialStore } from './credential-store.js';
import { RememberedPasswordStore } from './remembered-login.js';
import { companyEndpoint, companyProfile } from './company-config.js';
import { createDiagnosticWriter } from './diagnostic.js';
import { HarnessHost, type HarnessState } from './harness-host.js';
import { CompanyError } from './types.js';
import { adminReadQuery } from './admin-query.js';
import { AccountUiStateStore } from './ui-state.js';
import { accountRuntimePaths } from './runtime-configuration.js';
import { emptyConversationState } from './runtime/empty-session-policy.mjs';
import { StartupUpdateController } from './startup-update.js';
import { createCompanyUpdater } from './electron-update.js';
import { IncrementalUpdateController } from './incremental-update.js';
import { updateTrust } from './update-trust.js';

const here = dirname(fileURLToPath(import.meta.url));
const uiFile = join(here, 'renderer/index.html');
const profile = companyProfile(join(app.getPath('appData'), 'RufaDSH'), app.isPackaged, process.env.RUFA_TEST_USER_DATA);
const userRoot = profile.userRoot;
app.setPath('userData', userRoot);
let win: BrowserWindow;
let view: WebContentsView | null = null;
let api: CompanyApi;
let host: HarnessHost;
let passwords: RememberedPasswordStore;
let passwordGeneration = 0;
let loginRequests = 0;
let rememberedPasswordInvalidated = false;
let loginNotice = '';
let accountPasswordPending = false;
let accountProfilePending = false;
let viewAccount: { origin: string; userId: string; deviceId?: string; epoch: number } | null = null;
let uiStateStore: AccountUiStateStore | null = null;
let accountCompletion: { id: string; target: WebContentsView; origin: string; timer?: ReturnType<typeof setTimeout> } | null = null;
let companyServer = '';
let quitting = false;
let viewVisible = false;
let authTimer: ReturnType<typeof setInterval> | undefined;
const dev = !app.isPackaged;
// Hidden desktop fixtures must keep painting and advancing media after reload.
// Ordinary development and packaged windows retain Electron's default throttling.
const hiddenWindowTest = dev && process.env.RUFA_TEST_HIDE_WINDOW === '1';
let booting = true;
let opening: Promise<HarnessState> | null = null;
let startupUpdate: StartupUpdateController | IncrementalUpdateController;
const HEADER_HEIGHT = 48;

function state() { return { ...api.state, harness: host.state, companyServer, development: dev, booting, loginNotice,
  version: app.getVersion(), update: startupUpdate?.state, changingPassword: accountPasswordPending }; }
function publicAccount() {
  const user = api.state.user;
  return user ? { username: user.username, displayName: user.displayName, jobTitle: user.jobTitle ?? '', role: user.role } : null;
}
function broadcast() {
  if (win && !win.isDestroyed()) win.webContents.send('rufa:state', state());
  if (view && viewAccount?.epoch === api.authorizationEpoch && viewAccount.userId === api.state.user?.id
    && !view.webContents.isDestroyed()) view.webContents.send('rufa:account-profile-changed', publicAccount());
}
function bounds() { if (view && win) { const { width, height } = win.getContentBounds(); view.setBounds({ x: 0, y: HEADER_HEIGHT, width, height: Math.max(0, height - HEADER_HEIGHT) }); } }
function hideHarness() { if (view) { view.webContents.send('rufa:workbench-visibility', false); view.setVisible(false); viewVisible = false; } }
function destroyHarnessView() { host.cancelFileVersions(); if (view) { win.contentView.removeChildView(view); view.webContents.close(); view = null; } viewAccount = null; uiStateStore = null; viewVisible = false; }

function installHarnessPermissions(target: WebContentsView, account: NonNullable<typeof viewAccount>) {
  const trusted = (contents: Electron.WebContents | null, details: { isMainFrame: boolean; requestingUrl?: string }, requestingOrigin?: string) => {
    try {
      return !quitting && view === target && viewAccount === account && contents === target.webContents && !contents.isDestroyed()
        && details.isMainFrame === true && new URL(details.requestingUrl ?? '').origin === account.origin
        && new URL(contents.getURL()).origin === account.origin
        && (requestingOrigin === undefined || new URL(requestingOrigin).origin === account.origin)
        && api.state.user?.id === account.userId && api.state.deviceId === account.deviceId && api.authorizationEpoch === account.epoch;
    } catch { return false; }
  };
  target.webContents.session.setPermissionCheckHandler((contents, permission, requestingOrigin, details) =>
    (permission === 'clipboard-sanitized-write' || permission === 'fullscreen') && trusted(contents, details, requestingOrigin));
  target.webContents.session.setPermissionRequestHandler(async (contents, permission, callback, details) => {
    if (!trusted(contents, details)) return callback(false);
    // Native writeClipboard uses this write-only browser permission. Reading
    // existing clipboard contents continues to require the explicit dialog.
    if (permission === 'clipboard-sanitized-write') return callback(true);
    // Fullscreen remains restricted to the signed-in main workbench frame;
    // Chromium additionally requires the user's activation on the player.
    if (permission === 'fullscreen') return callback(true);
    if (!['media', 'clipboard-read'].includes(permission)) return callback(false);
    try {
      const result = await dialog.showMessageBox(win, { type: 'question', buttons: ['不允许', '允许本次'], defaultId: 0, cancelId: 0,
        message: permission === 'media' ? '允许 Rufajx-DSH 使用麦克风或摄像头？' : '允许 Rufajx-DSH 读取剪贴板？' });
      callback(result.response === 1 && trusted(contents, details));
    } catch { callback(false); }
  });
}

async function openHarness() {
  if (opening) return opening;
  opening = loadHarness().finally(() => { opening = null; });
  return opening;
}
async function loadHarness() {
  const url = await host.start();
  const accountUser = api.state.user, accountServer = api.state.serverUrl;
  if (!accountUser || !accountServer) throw new CompanyError('OPEN_CANCELLED', '工作台打开已取消。');
  if (!view) {
    uiStateStore = new AccountUiStateStore(accountRuntimePaths(realpathSync.native(join(userRoot, 'accounts')), accountServer, accountUser.id).companyHome);
    const partition = `persist:rufa-${createHash('sha256').update(`${accountServer}:${accountUser.id}`).digest('hex').slice(0, 24)}`;
    view = new WebContentsView({ webPreferences: { partition, preload: join(here, 'account-preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true,
      ...(hiddenWindowTest ? { backgroundThrottling: false } : {}) } });
    view.setBackgroundColor('#111111');
    view.setVisible(false);
    const origin = new URL(url).origin;
    viewAccount = { origin, userId: accountUser.id, deviceId: api.state.deviceId, epoch: api.authorizationEpoch };
    view.webContents.setWindowOpenHandler(({ url: target }) => {
      const parsed = new URL(target);
      if (['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password && parsed.origin !== origin) void shell.openExternal(target);
      return { action: 'deny' };
    });
    view.webContents.on('will-navigate', (event, target) => { if (new URL(target).origin !== origin) event.preventDefault(); });
    installHarnessPermissions(view, viewAccount);
    win.contentView.addChildView(view);
    bounds();
    const loadingView = view;
    try { await loadingView.webContents.loadURL(url); }
    catch (error) { if (view === loadingView) destroyHarnessView(); throw error; }
    if (view !== loadingView || !api.state.user) throw new CompanyError('OPEN_CANCELLED', '工作台打开已取消。');
  }
  view.setVisible(true); viewVisible = true; view.webContents.send('rufa:workbench-visibility', true); bounds(); view.webContents.focus(); return host.state;
}
function id(value: unknown): string { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(value)) throw new CompanyError('INVALID_ID', '无效的账号或会话。'); return encodeURIComponent(value); }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CompanyError('INVALID_INPUT', '无效的操作参数。'); return value as Record<string, unknown>; }
async function admin() { const current = await api.verify(); if (current.user?.role !== 'admin') throw new CompanyError('FORBIDDEN', '仅管理账号可以执行此操作。', 403); return current; }
function keyStatus(value: { configured?: boolean; updatedAt?: unknown }) { return { configured: value.configured === true, updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null }; }

function trustedAccountFrame(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent, target: WebContentsView, origin: string): boolean {
  try { return !target.webContents.isDestroyed() && event.sender === target.webContents
    && event.senderFrame === target.webContents.mainFrame && new URL(event.senderFrame!.url).origin === origin; }
  catch { return false; }
}
function finishAccountPasswordChange(id: string) {
  const completion = accountCompletion;
  if (!completion || completion.id !== id) return;
  accountCompletion = null; clearTimeout(completion.timer);
  if (view === completion.target) { destroyHarnessView(); void host.stop().catch(() => {}); }
}
function requireAccount(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) {
  if (!view || !viewAccount || !trustedAccountFrame(event, view, viewAccount.origin)
    || viewAccount.epoch !== api.authorizationEpoch || viewAccount.userId !== api.state.user?.id
    || viewAccount.deviceId !== api.state.deviceId || quitting) throw new CompanyError('LOGIN_REQUIRED', '请在当前已登录的公司工作台操作。', 401);
}
function accountUiState(event: Electron.IpcMainEvent, operation: 'load' | 'commit', input?: unknown) {
  requireAccount(event);
  if (!uiStateStore) throw new CompanyError('UI_STATE_UNAVAILABLE', '工作台本地状态尚未就绪。');
  if (operation === 'commit') uiStateStore.commit(input);
  return operation === 'load' ? uiStateStore.snapshot() : null;
}
async function workPreferences(event: Electron.IpcMainInvokeEvent, input: unknown) {
  requireAccount(event);
  const value = object(input), target = view, epoch = api.authorizationEpoch;
  if (typeof value.action !== 'string' || !['snapshot', 'mutate', 'history', 'sync', 'resolve'].includes(value.action)) throw new CompanyError('INVALID_REQUEST', '不支持这个工作偏好操作。');
  const controller = new AbortController(), contents = target!.webContents, cancel = () => controller.abort();
  contents.on('destroyed', cancel); contents.on('render-process-gone', cancel); contents.on('did-start-navigation', cancel);
  try {
    const result = await host.preferences(value.action, value.input, controller.signal);
    controller.signal.throwIfAborted(); requireAccount(event);
    if (view !== target || api.authorizationEpoch !== epoch) throw new CompanyError('LOGIN_CHANGED', '工作台已变化，请重新打开工作偏好。');
    return result;
  } finally { contents.removeListener('destroyed', cancel); contents.removeListener('render-process-gone', cancel); contents.removeListener('did-start-navigation', cancel); }
}
async function discardEmptySession(event: Electron.IpcMainInvokeEvent, input: unknown) {
  requireAccount(event);
  const value = object(input), sessionId = value.sessionId;
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(sessionId)) throw new CompanyError('INVALID_ID', '无效的会话。');
  const store = uiStateStore, key = `dsh.conversation.${sessionId}`;
  if (!store || !emptyConversationState(store.snapshot().entries[key])) return { deleted: false };
  const target = view!;
  const deleted = await host.discardEmptySession(sessionId, async () => {
    requireAccount(event);
    if (store !== uiStateStore || view !== target || !emptyConversationState(store.snapshot().entries[key])) return false;
    const allowed = await target.webContents.executeJavaScript(`window.__RUFA_CONFIRM_EMPTY_DISCARD__?.(${JSON.stringify(sessionId)}) === true`);
    requireAccount(event);
    return allowed === true && store === uiStateStore && view === target && emptyConversationState(store.snapshot().entries[key]);
  });
  requireAccount(event);
  if (deleted && store === uiStateStore && emptyConversationState(store.snapshot().entries[key])) store.commit({ remove: [key] });
  return { deleted };
}
async function fileVersions(event: Electron.IpcMainInvokeEvent, input: unknown) {
  requireAccount(event);
  const value = object(input);
  if (typeof value.action !== 'string' || !['history', 'compare', 'prepareRestore', 'restore'].includes(value.action)) throw new CompanyError('INVALID_REQUEST', '不支持这个文件版本操作。');
  const epoch = api.authorizationEpoch, target = view, userId = api.state.user?.id, deviceId = api.state.deviceId;
  const valid = () => {
    try { requireAccount(event); return view === target && api.authorizationEpoch === epoch && api.state.user?.id === userId && api.state.deviceId === deviceId; }
    catch { return false; }
  };
  await api.verify();
  if (!valid()) throw new CompanyError('LOGIN_CHANGED', '账号已变化，请重新打开文件版本。');
  const contents = target!.webContents, cancel = () => host.cancelFileVersions();
  contents.on('destroyed', cancel); contents.on('render-process-gone', cancel); contents.on('did-start-navigation', cancel);
  try {
    const result = await host.fileVersions(value.action, value.input, valid);
    if (!valid()) throw new CompanyError('LOGIN_CHANGED', '账号已变化，请重新打开文件版本。');
    return result;
  } finally { contents.removeListener('destroyed', cancel); contents.removeListener('render-process-gone', cancel); contents.removeListener('did-start-navigation', cancel); }
}
async function updateAccountProfile(event: Electron.IpcMainInvokeEvent, input: unknown) {
  requireAccount(event);
  if (accountPasswordPending || accountProfilePending || accountCompletion) throw new CompanyError('ACCOUNT_UPDATE_PENDING', '正在保存账号信息，请稍候。');
  const value = object(input);
  if (typeof value.displayName !== 'string' || !value.displayName.trim() || value.displayName.length > 128
    || typeof value.jobTitle !== 'string' || value.jobTitle.length > 100) throw new CompanyError('INVALID_REQUEST', '姓名须为 1–128 位，职位最多 100 位，可留空。', 400);
  accountProfilePending = true;
  try { await api.updateProfile(value.displayName, value.jobTitle); requireAccount(event); return publicAccount(); }
  finally { accountProfilePending = false; }
}
async function changeAccountPassword(event: Electron.IpcMainInvokeEvent, input: unknown) {
  const target = view, account = viewAccount;
  if (!target || !account || !trustedAccountFrame(event, target, account.origin)) throw new CompanyError('UNTRUSTED_ACCOUNT_VIEW', '请在当前公司工作台修改密码。');
  const stillCurrent = () => view === target && trustedAccountFrame(event, target, account.origin)
    && api.authorizationEpoch === account.epoch && api.state.user?.id === account.userId && api.state.deviceId === account.deviceId;
  if (!stillCurrent() || quitting) throw new CompanyError('LOGIN_REQUIRED', '请重新登录公司账号。', 401);
  if (accountPasswordPending || accountProfilePending || accountCompletion) throw new CompanyError('PASSWORD_CHANGE_PENDING', '正在更新账号信息，请稍候。');
  const value = object(input);
  if (typeof value.currentPassword !== 'string' || !value.currentPassword || typeof value.newPassword !== 'string'
    || value.newPassword.length < 12 || value.currentPassword.length > 128 || value.newPassword.length > 128) {
    value.currentPassword = ''; value.newPassword = '';
    throw new CompanyError('INVALID_PASSWORD', '请填写原密码和 12–128 位的新密码。', 400);
  }
  accountPasswordPending = true;
  broadcast();
  try {
    const receipt = await api.changePassword(value.currentPassword, value.newPassword);
    const sameLogin = receipt.loginLifecycleEpoch === api.loginLifecycleEpoch && receipt.userId === account.userId
      && receipt.serverUrl === companyServer && view === target && trustedAccountFrame(event, target, account.origin)
      && (!api.state.user || api.state.user.id === account.userId && api.state.deviceId === account.deviceId);
    if (!sameLogin) throw new CompanyError('LOGIN_CANCELLED', '修改请求所属的登录已结束，请使用新密码重新登录。', 401);
    ++passwordGeneration; rememberedPasswordInvalidated = true;
    const id = randomUUID();
    accountCompletion = { id, target, origin: account.origin };
    let localCleanupComplete = true;
    try { await passwords.clear(); } catch { localCleanupComplete = false; }
    try { await api.clearLocalLogin(); } catch { localCleanupComplete = false; }
    loginNotice = localCleanupComplete ? '密码已修改，请使用新密码重新登录。' : '密码已修改。本机旧凭据清理失败，请联系管理员并使用新密码登录。';
    hideHarness(); broadcast();
    accountCompletion.timer = setTimeout(() => finishAccountPasswordChange(id), 5000);
    return { changed: true, localCleanupComplete, completionId: id };
  } finally {
    value.currentPassword = ''; value.newPassword = ''; accountPasswordPending = false;
    if (!api.state.user && !accountCompletion) { destroyHarnessView(); void host.stop().catch(() => {}); broadcast(); }
    else broadcast();
  }
}

async function command(action: string, input: unknown) {
  if (action === 'update.retry' || action === 'update.continue') {
    if (input !== undefined && input !== null) throw new CompanyError('INVALID_INPUT', '更新操作不接受外部地址或文件。');
    if (!booting || !startupUpdate?.blocking || api.state.user || view || quitting) throw new CompanyError('UPDATE_CLOSED', '本次启动更新已经结束。');
    if (action === 'update.retry') startupUpdate.retry(); else startupUpdate.continueCurrent();
    return state();
  }
  if (booting && action !== 'state') throw new CompanyError('STARTUP_PENDING', '正在准备客户端，请稍候。');
  switch (action) {
    case 'state': return state();
    case 'login.saved': {
      if (rememberedPasswordInvalidated || accountPasswordPending) return { remembered: false, username: '' };
      try { return await passwords.info(companyServer); }
      catch { throw new CompanyError('PASSWORD_READ_FAILED', '无法读取保存的密码，请重新输入，或取消记住密码。'); }
    }
    case 'login.revealSavedPassword': {
      const value = object(input);
      const username = typeof value.username === 'string' ? value.username.trim() : '';
      const canReveal = () => !booting && !quitting && !api.state.user && loginRequests === 0
        && !rememberedPasswordInvalidated && !accountPasswordPending && !accountCompletion;
      if (!username || username.length > 160 || !canReveal()) throw new CompanyError('PASSWORD_REVEAL_UNAVAILABLE', '当前无法显示保存的密码。');
      const generation = passwordGeneration;
      let password = '';
      try {
        // The authenticated local shell is the only IPC sender. Never accept a server URL from its input.
        try { password = await passwords.passwordFor(companyServer, username) ?? ''; }
        catch { throw new CompanyError('PASSWORD_READ_FAILED', '无法读取保存的密码，请重新输入，或取消记住密码。'); }
        if (!canReveal() || generation !== passwordGeneration) throw new CompanyError('PASSWORD_REVEAL_CANCELLED', '密码显示已取消。');
        if (!password) throw new CompanyError('PASSWORD_REQUIRED', '此账号没有保存的密码，请重新输入。');
        return { password };
      } finally { password = ''; }
    }
    case 'login.forget': ++passwordGeneration; await passwords.clear(); rememberedPasswordInvalidated = false; return { remembered: false, username: '' };
    case 'login': {
      if (accountPasswordPending || accountCompletion) throw new CompanyError('PASSWORD_CHANGE_PENDING', '正在完成密码修改，请稍候再登录。');
      loginNotice = '';
      const value = object(input);
      const username = String(value.username ?? '').trim();
      let password = typeof value.password === 'string' ? value.password : '';
      const remember = value.rememberPassword === true;
      const generation = ++passwordGeneration;
      ++loginRequests;
      try {
        if (!password && value.useSavedPassword === true) {
          if (rememberedPasswordInvalidated) throw new CompanyError('PASSWORD_REQUIRED', '密码已修改，请输入新密码。');
          password = await passwords.passwordFor(companyServer, username) ?? '';
          if (!password) throw new CompanyError('PASSWORD_REQUIRED', '请重新输入此账号的密码。');
        }
        if (!remember) await passwords.clear();
        if (api.state.user) { destroyHarnessView(); await host.stop(); await api.logout(); }
        try { await api.login(companyServer, username, password, hostname()); }
        catch (error) {
          if (value.useSavedPassword === true && error instanceof CompanyError && [401, 403].includes(error.status ?? 0)) {
            await passwords.clear();
            throw new CompanyError('SAVED_PASSWORD_EXPIRED', '保存的密码已失效，请重新输入密码。');
          }
          throw error;
        }
        if (remember && generation === passwordGeneration) {
          try { await passwords.write(companyServer, username, password); rememberedPasswordInvalidated = false; }
          catch { await api.logout(); throw new CompanyError('PASSWORD_SAVE_FAILED', '无法安全记住密码，请取消勾选后重试。'); }
        }
        return state();
      } finally { password = ''; value.password = ''; --loginRequests; }
    }
    case 'logout':
      if (accountPasswordPending) throw new CompanyError('PASSWORD_CHANGE_PENDING', '正在修改密码，请稍候。');
      ++passwordGeneration; destroyHarnessView(); await host.stop(); await api.logout(); return state();
    case 'harness.open': return openHarness();
    case 'harness.hide': hideHarness(); return host.state;
    case 'admin.users': await admin(); return api.json('GET', '/admin/users');
    case 'admin.querySessions': await admin(); return api.json('GET', adminReadQuery('sessions', input));
    case 'admin.overview': await admin(); return api.json('GET', adminReadQuery('overview', input));
    case 'admin.deepseekStatus': await admin(); return keyStatus(await api.json('GET', '/admin/settings/deepseek'));
    case 'admin.saveDeepseekKey': {
      await admin(); const value = object(input);
      if (typeof value.apiKey !== 'string' || !value.apiKey.trim()) throw new CompanyError('INVALID_KEY', '请输入有效的 DeepSeek API Key。');
      return keyStatus(await api.json('PUT', '/admin/settings/deepseek', { apiKey: value.apiKey.trim() }));
    }
    case 'admin.createUser': {
      await admin(); const value = object(input);
      return api.json('POST', '/admin/users', { username: value.username, displayName: value.displayName, jobTitle: value.jobTitle, password: value.password, role: value.role });
    }
    case 'admin.updateUser': {
      await admin(); const value = object(input);
      return api.json('PATCH', `/admin/users/${id(value.id)}`, { displayName: value.displayName, jobTitle: value.jobTitle, role: value.role, status: value.status });
    }
    case 'admin.resetPassword': {
      await admin(); const value = object(input);
      await api.json('POST', `/admin/users/${id(value.id)}/reset-password`, { password: value.password }); return { ok: true };
    }
    case 'admin.deleteUser': {
      const manager = await admin(); const value = object(input);
      const result = await dialog.showMessageBox(win, { type: 'warning', message: '将这个账号移入回收站？', detail: '账号将立即停用并退出所有设备。7 天内可恢复，到期后账号资料清除，聊天记录仍会归档保留。', buttons: ['取消', '移入回收站'], defaultId: 0, cancelId: 0 });
      if (result.response !== 1) return { cancelled: true };
      if ((await admin()).user?.id !== manager.user?.id) throw new CompanyError('AUTH_CHANGED', '管理账号已切换，请重新确认操作。');
      await api.json('DELETE', `/admin/users/${id(value.id)}`); return { ok: true };
    }
    case 'admin.restoreUser': {
      await admin(); const value = object(input);
      try { return await api.json('POST', `/admin/users/${id(value.id)}/restore`); }
      catch (error) {
        if (error instanceof CompanyError && error.code === 'RESTORE_EXPIRED') throw new CompanyError('RESTORE_EXPIRED', '账号已超过 7 天保留期，无法恢复；聊天记录仍可在聊天档案中查询。', error.status);
        if (error instanceof CompanyError && error.code === 'USER_NOT_DELETED') throw new CompanyError('USER_NOT_DELETED', '账号已不在回收站，请刷新账号列表。', error.status);
        throw error;
      }
    }
    case 'admin.sessions': await admin(); return api.json('GET', `/admin/users/${id(object(input).id)}/sessions`);
    case 'admin.events': {
      await admin(); const value = object(input);
      const afterSeq = Number.isSafeInteger(value.afterSeq) && Number(value.afterSeq) >= -1 ? value.afterSeq : -1;
      return api.json('GET', `/admin/sessions/${id(value.id)}/events?afterSeq=${afterSeq}&limit=200`);
    }
    default: throw new CompanyError('UNKNOWN_ACTION', '不支持此操作。');
  }
}

async function main() {
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  await app.whenReady();
  nativeTheme.themeSource = 'dark';
  const endpoint = companyEndpoint(app.isPackaged, profile.isolatedTestProfile, process.env.RUFA_TEST_SERVER_URL);
  companyServer = endpoint.server;
  api = new CompanyApi(new EncryptedCredentialStore(join(userRoot, 'login.enc'), safeStorage), endpoint.allowLocalHttp, fetch, companyServer);
  passwords = new RememberedPasswordStore(join(userRoot, 'remembered-login.enc'), safeStorage);
  host = new HarnessHost(api, {
    runtimeRoot: app.isPackaged ? join(process.resourcesPath, 'harness') : process.env.RUFA_UPSTREAM_ROOT ?? join(app.getPath('home'), 'AppData/Local/RufaDSH/development/upstream'),
    pluginRoot: app.isPackaged ? join(process.resourcesPath, 'company-plugins') : join(here, 'runtime'), userRoot: join(userRoot, 'accounts'),
    execPath: app.isPackaged ? join(process.resourcesPath, 'node/node.exe') : join(here, '../node-runtime/node.exe'), electronMode: false,
    // Only the known company profile hosted by Codex's Windows MSIX package.
    // No general Agent-profile scan or credential/settings import is performed.
    ...(app.isPackaged && process.platform === 'win32' ? { legacyProjectAccountsRoot: join(app.getPath('home'),
      'AppData/Local/Packages/OpenAI.Codex_2p2nqsd0c76g0/LocalCache/Roaming/RufaDSH/accounts') } : {}),
    diagnostic: dev && process.env.RUFA_TEST_DIAGNOSTIC === '1' ? createDiagnosticWriter(process.stderr) : undefined,
  });
  const canInstallUpdate = () => booting && !quitting && !api.state.user && !view && !opening && host.state.status === 'stopped';
  const fallbackUpdater = () => new StartupUpdateController({ enabled: app.isPackaged && process.platform === 'win32' && process.arch === 'x64',
    currentVersion: app.getVersion(), createUpdater: createCompanyUpdater,
    canInstall: canInstallUpdate,
  });
  startupUpdate = app.isPackaged && process.platform === 'win32' && process.arch === 'x64' && !process.argv.includes('--rufa-update-recovered')
    ? new IncrementalUpdateController({ root: dirname(app.getPath('exe')), currentVersion: app.getVersion(), trust: updateTrust,
      canInstall: canInstallUpdate, createFallback: fallbackUpdater, onHandoff: () => app.quit() })
    : new StartupUpdateController({ enabled: false, currentVersion: app.getVersion(), createUpdater: createCompanyUpdater, canInstall: canInstallUpdate });
  if (process.argv.includes('--rufa-update-recovered')) loginNotice = '上次更新未完成，已恢复原有版本；本次可以继续使用。';
  startupUpdate.on('change', broadcast);
  win = new BrowserWindow({ width: 1380, height: 900, minWidth: 900, minHeight: 600, title: 'Rufajx-DSH', backgroundColor: '#111111', show: false,
    icon: join(here, 'renderer/assets/rufajx-mark.png'),
    webPreferences: { preload: join(here, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true,
      ...(hiddenWindowTest ? { backgroundThrottling: false } : {}) } });
  win.removeMenu();
  for (const operation of ['load', 'commit'] as const) ipcMain.on(`rufa:ui-state:${operation}`, (event, input) => {
    try { event.returnValue = { ok: true, value: accountUiState(event, operation, input) }; }
    catch { event.returnValue = { ok: false }; } // No local paths, drafts or credentials in errors/logs.
  });
  ipcMain.handle('rufa:command', async (event, action, input) => {
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== pathToFileURL(uiFile).href) throw new Error('Untrusted sender');
    try { return { ok: true, value: await command(action, input) }; }
    catch (error) { return { ok: false, error: { code: error instanceof CompanyError ? error.code : 'CLIENT_ERROR', message: error instanceof CompanyError ? error.message : '操作未完成，请检查连接后重试。' } }; }
  });
  ipcMain.handle('rufa:account-change-password', async (event, input) => {
    try {
      const { completionId, ...value } = await changeAccountPassword(event, input);
      return { ok: true, value, completionId };
    } catch (error) {
      return { ok: false, error: { code: error instanceof CompanyError ? error.code : 'CLIENT_ERROR',
        message: error instanceof CompanyError ? error.message : '密码修改未完成，请稍后重试。' } };
    }
  });
  ipcMain.handle('rufa:discard-empty-session', async (event, input) => {
    try { return { ok: true, value: await discardEmptySession(event, input) }; }
    catch { return { ok: false, error: { code: 'DISCARD_UNAVAILABLE', message: '空白会话暂未清理，已保留。' } }; }
  });
  ipcMain.handle('rufa:file-versions', async (event, input) => {
    try { return { ok: true, value: await fileVersions(event, input) }; }
    catch (error) { return { ok: false, error: { code: error instanceof CompanyError ? error.code : 'FILE_VERSIONS_FAILED',
      message: error instanceof CompanyError ? error.message : '文件版本暂不可用，请重试。' } }; }
  });
  ipcMain.handle('rufa:preferences', async (event, input) => {
    try { return { ok: true, value: await workPreferences(event, input) }; }
    catch (error) { return { ok: false, error: { code: error instanceof CompanyError ? error.code : 'PREFERENCES_FAILED',
      message: error instanceof CompanyError ? error.message : '工作偏好操作未完成，请刷新后重试。' } }; }
  });
  for (const action of ['rufa:account-profile', 'rufa:account-update-profile']) ipcMain.handle(action, async (event, input) => {
    try {
      requireAccount(event);
      return { ok: true, value: action === 'rufa:account-profile' ? publicAccount() : await updateAccountProfile(event, input) };
    } catch (error) {
      return { ok: false, error: { code: error instanceof CompanyError ? error.code : 'CLIENT_ERROR',
        message: error instanceof CompanyError ? error.message : '账号资料保存失败，请稍后重试。' } };
    }
  });
  ipcMain.on('rufa:account-change-complete', (event, id) => {
    const completion = accountCompletion;
    if (completion && typeof id === 'string' && id === completion.id && trustedAccountFrame(event, completion.target, completion.origin)) finishAccountPasswordChange(id);
  });
  api.on('change', () => {
    if (accountPasswordPending || accountCompletion) return; // Keep the account view alive until its reply is acknowledged.
    if (!api.state.user) { destroyHarnessView(); void host.stop(); }
    if (api.state.user?.role !== 'admin') { /* The renderer will remove all management panels on state update. */ }
    broadcast();
  });
  host.on('change', broadcast);
  host.on('preferences-change', notice => {
    if (view && viewAccount && !view.webContents.isDestroyed() && viewAccount.epoch === api.authorizationEpoch
      && viewAccount.userId === api.state.user?.id && viewAccount.deviceId === api.state.deviceId) view.webContents.send('rufa:preferences-changed', notice ?? null);
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => { if (url !== pathToFileURL(uiFile).href) event.preventDefault(); });
  win.on('resize', bounds);
  win.on('close', event => {
    if (quitting) return; event.preventDefault();
    quitting = true; startupUpdate.stop(); clearInterval(authTimer);
    void host.stop().finally(() => { destroyHarnessView(); app.quit(); });
  });
  app.on('second-instance', () => { if (win.isMinimized()) win.restore(); win.focus(); });
  await win.loadFile(uiFile); if (!hiddenWindowTest) win.show();
  if (!await startupUpdate.start() || quitting) return;
  try { await api.restore(); } catch { /* The login form can recover expired or unavailable credentials. */ }
  booting = false; broadcast();
  authTimer = setInterval(() => { if (api.state.user && !accountPasswordPending) void api.verify().catch(() => {}); }, 30_000);
}
void main().catch(() => { dialog.showErrorBox('Rufajx-DSH', '客户端启动失败，请联系管理员检查安装。'); app.quit(); });
