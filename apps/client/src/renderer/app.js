import { createAdminCenter } from './admin-center.mjs';

import { updatePresentation } from './update-view.mjs';
const $ = id => document.getElementById(id);
let current = null, panel = 'loading';
let saved = { remembered: false, username: '' }, savedRequest = 0;
let loginPending = false, logoutPending = false, opening = null, viewEpoch = 0;
let passwordVisible = false, savedPasswordVisible = false, passwordRevealPending = false, passwordRevealEpoch = 0;


let updateActionPending = false, updateRetryCooling = false;
const adminCenter = createAdminCenter({ call, notice, getUser: () => current?.user });
async function call(action, input) {
  const response = await window.rufa.call(action, input);
  if (!response.ok) throw Object.assign(new Error(response.error.message), { code: response.error.code, status: response.error.status });
  return response.value;
}
function notice(message) { $('notice').textContent = message; $('notice').hidden = false; }
function hideNotice() { $('notice').hidden = true; }
async function guarded(task) { hideNotice(); try { return await task(); } catch (error) { notice(error.message); } }
function updateRecoveryControls() {
  $('update-retry').disabled = updateActionPending || updateRetryCooling;
  $('update-continue').disabled = updateActionPending;
}
async function updateAction(action) {
  if (updateActionPending || action === 'update.retry' && updateRetryCooling) return;
  updateActionPending = true;
  if (action === 'update.retry') {
    // The server may fail before a second physical click arrives. Keep that
    // double click one retry, even if error -> checking -> error is immediate.
    updateRetryCooling = true;
    setTimeout(() => { updateRetryCooling = false; updateRecoveryControls(); }, 400);
  }
  updateRecoveryControls();
  try { await guarded(() => call(action)); }
  finally { updateActionPending = false; updateRecoveryControls(); }
}
function show(which) {
  if (panel === 'admin' && which !== 'admin') adminCenter.deactivate();
  panel = which;
  if (which !== 'login') hidePassword();
  else passwordToggleState();
  for (const name of ['login', 'loading', 'admin']) $(name + '-view').hidden = which !== name;
  $('open-harness').setAttribute('aria-current', which === 'admin' ? 'false' : 'page');
  $('open-admin').setAttribute('aria-current', which === 'admin' ? 'page' : 'false');
}
function loading(message, failed = false) {
  show('loading'); $('loading-message').textContent = message;
  $('loading-spinner').hidden = failed; $('retry-harness').hidden = !failed || !current?.user;
  $('update-status').hidden = true; $('update-actions').hidden = true;
}
function renderStartupUpdate(update) {
  const value = updatePresentation(update);
  if (!value) return false;
  loading(value.message, value.failed);
  $('retry-harness').hidden = true;
  $('update-status').hidden = false; $('update-detail').textContent = value.detail;
  $('update-progress').hidden = !value.progress; $('update-progress').value = value.percent;
  $('update-actions').hidden = !value.retry && !value.continueCurrent;
  $('update-retry').hidden = !value.retry; $('update-continue').hidden = !value.continueCurrent;
  updateRecoveryControls();
  return true;
}
function controls() {
  const busy = loginPending || logoutPending || !!opening || current?.changingPassword;
  $('open-harness').disabled = busy; $('open-admin').disabled = busy;
  $('logout').disabled = loginPending || logoutPending || !!current?.changingPassword;
  passwordToggleState();
}
function passwordToggleState() {
  const active = passwordVisible || passwordRevealPending;
  const label = passwordRevealPending ? '取消显示密码' : passwordVisible ? '隐藏密码' : '显示密码';
  $('toggle-password').setAttribute('aria-label', label);
  $('toggle-password').setAttribute('aria-pressed', String(active));
  $('toggle-password').setAttribute('aria-busy', String(passwordRevealPending));
  $('toggle-password').title = label;
  $('toggle-password').disabled = panel !== 'login' || !!current?.user || loginPending || logoutPending;
}
function hidePassword() {
  ++passwordRevealEpoch; passwordRevealPending = false;
  // Stored plaintext exists only in the visible field. Hand-entered values keep normal input semantics.
  if (savedPasswordVisible) $('password').value = '';
  savedPasswordVisible = false; passwordVisible = false; $('password').type = 'password';
  passwordToggleState();
}
function hasSavedPassword() { return saved.remembered && $('remember-password').checked && saved.username === $('username').value.trim(); }
function passwordHint() {
  const available = hasSavedPassword();
  // The saved credential uses a fixed-length placeholder until the user explicitly requests a reveal.
  $('password').placeholder = available ? '••••••••' : '请输入密码';
  $('password').toggleAttribute('data-saved-password', available);
  if (available) $('password').setAttribute('aria-description', '密码已保存，可直接登录；点击显示密码可临时查看，输入新密码可替换。');
  else $('password').removeAttribute('aria-description');
  $('password').required = !available;
}
async function togglePassword() {
  if (panel !== 'login' || current?.user || loginPending || logoutPending) return;
  if (passwordVisible || passwordRevealPending) { hidePassword(); passwordHint(); return; }
  if ($('password').value || !hasSavedPassword()) {
    passwordVisible = true; $('password').type = 'text'; passwordToggleState(); return;
  }
  const epoch = ++passwordRevealEpoch, username = $('username').value.trim();
  passwordRevealPending = true; passwordToggleState(); hideNotice();
  const stillCurrent = () => epoch === passwordRevealEpoch && panel === 'login' && !current?.user
    && !loginPending && !logoutPending && hasSavedPassword() && $('username').value.trim() === username && !$('password').value;
  let response;
  try {
    response = await call('login.revealSavedPassword', { username });
    if (!stillCurrent()) return;
    if (typeof response?.password !== 'string' || !response.password) throw new Error('此账号没有保存的密码，请重新输入。');
    $('password').value = response.password; savedPasswordVisible = true;
    passwordVisible = true; $('password').type = 'text';
  } catch (error) {
    if (stillCurrent()) { hidePassword(); notice(error.message); }
  } finally {
    if (response && typeof response === 'object') response.password = '';
    if (epoch === passwordRevealEpoch) { passwordRevealPending = false; passwordToggleState(); }
  }
}
async function loadSavedLogin() {
  const request = ++savedRequest;
  try {
    const value = await call('login.saved');
    if (request !== savedRequest || panel !== 'login' || current?.user || loginPending) return;
    hidePassword();
    saved = value; $('remember-password').checked = value.remembered;
    if (value.remembered) $('username').value = value.username;
    passwordHint();
  } catch (error) {
    if (request !== savedRequest || panel !== 'login' || current?.user || loginPending) return;
    saved = { remembered: false, username: '' }; passwordHint();
    $('remember-password').checked = true; notice(error.message);
  }
}
function render(state) {
  const prior = current, changedUser = prior?.user?.id !== state.user?.id;
  current = state; adminCenter.syncIdentity(state.user);
  if (changedUser) { viewEpoch++; opening = null; }
  const signed = !!state.user;
  if (signed) hidePassword();
  document.body.classList.toggle('signed-in', signed);
  $('app-header').hidden = !signed; $('open-admin').hidden = state.user?.role !== 'admin';
  $('identity').textContent = signed ? state.user.displayName + ' · ' + (state.user.role === 'admin' ? '管理' : '员工') : '';
  controls();
  $('client-version').textContent = state.version ? `版本 ${state.version}` : '';
  if (state.booting) { if (!renderStartupUpdate(state.update)) loading('正在恢复登录…'); return; }
  if (logoutPending || loginPending) return;
  if (!signed) {
    const entering = panel !== 'login'; show('login');
    if (entering) {
      $('password').value = ''; $('api-key').value = ''; void loadSavedLogin();
    }
    if (state.loginNotice) notice(state.loginNotice);
    return;
  }
  if (changedUser || prior?.booting || panel === 'login' || (!prior?.user && panel === 'loading') || (panel === 'admin' && state.user.role !== 'admin')) {
    void openHarness();
  } else if (state.harness.status === 'failed' && panel === 'workbench') {
    void guarded(() => call('harness.hide')); loading(state.harness.message || '工作台已退出，请重新打开。', true);
  } else if (opening && state.harness.message) $('loading-message').textContent = state.harness.message;
}
async function openHarness() {
  if (!current?.user || logoutPending) return;
  if (opening) return opening;
  hideNotice(); loading('正在准备工作台…');
  const epoch = viewEpoch;
  const operation = (async () => {
    try { await call('harness.open'); if (epoch === viewEpoch && current?.user && !logoutPending) show('workbench'); }
    catch (error) { if (epoch === viewEpoch && current?.user && !logoutPending) loading(error.message, true); }
    finally { if (epoch === viewEpoch) { opening = null; controls(); } }
  })();
  opening = operation; controls(); return operation;
}
$('toggle-password').onclick = togglePassword;
$('update-retry').onclick = () => updateAction('update.retry');
$('update-continue').onclick = () => updateAction('update.continue');
$('username').oninput = () => { ++savedRequest; hidePassword(); passwordHint(); };
$('password').oninput = () => {
  ++savedRequest; ++passwordRevealEpoch; passwordRevealPending = false;
  savedPasswordVisible = false; passwordHint(); passwordToggleState();
};
$('remember-password').onchange = () => {
  ++savedRequest; hidePassword();
  passwordHint();
  if ($('remember-password').checked) return;
  saved = { remembered: false, username: '' }; passwordHint();
  void guarded(() => call('login.forget'));
};
$('login-form').onsubmit = event => {
  event.preventDefault(); if (loginPending) return;
  void guarded(async () => {
    const useSavedPassword = hasSavedPassword() && (!$('password').value || savedPasswordVisible);
    const value = { username: $('username').value.trim(), password: useSavedPassword ? '' : $('password').value, rememberPassword: $('remember-password').checked, useSavedPassword };
    $('password').value = ''; loginPending = true; ++savedRequest; hideNotice(); loading('正在登录…'); controls();
    try {
      const state = await call('login', value);
      loginPending = false; render(state); await openHarness();
    } catch (error) { loginPending = false; if (current) render(current); throw error; }
    finally { value.password = ''; loginPending = false; controls(); }
  });
};
$('logout').onclick = () => guarded(async () => {
  logoutPending = true; viewEpoch++; opening = null; controls(); loading('正在保存并退出…');
  try { const state = await call('logout'); logoutPending = false; render(state); }
  finally { logoutPending = false; controls(); }
});
$('retry-harness').onclick = openHarness; $('open-harness').onclick = openHarness;
$('open-admin').onclick = () => guarded(async () => {
  const epoch = viewEpoch;
  if (current?.user?.role !== 'admin') return;
  await call('harness.hide');
  if (epoch !== viewEpoch || current?.user?.role !== 'admin') return;
  show('admin'); await adminCenter.open();
});
window.addEventListener('pagehide', hidePassword);
window.rufa.onState(render); void guarded(async () => render(await call('state')));
