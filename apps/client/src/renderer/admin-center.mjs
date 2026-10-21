import { projectEvent, rawText } from './admin-events.mjs';
import { markdown } from './admin-markdown.mjs';
import { appendEventPage, dateRange } from './admin-history.mjs';
import { recycleStatus } from './recycle-status.mjs';

const $ = id => document.getElementById(id);
const el = (tag, text, className) => { const node = document.createElement(tag); if (text != null) node.textContent = text; if (className) node.className = className; return node; };
const date = value => { const time = new Date(value); return Number.isFinite(time.getTime()) ? time.toLocaleString('zh-CN', { hour12: false }) : '时间未记录'; };
const shortDate = value => { const time = new Date(value); return Number.isFinite(time.getTime()) ? time.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) : '—'; };
const number = value => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN') : '—';
const unsupported = error => ['NOT_FOUND','UNKNOWN_ACTION'].includes(error.code) || error.status === 404;
const button = (text, action, className = 'quiet') => { const node = el('button', text, className); node.type = 'button'; node.onclick = action; return node; };
function empty(target, title, detail) { const node = el('div', null, 'admin-empty'); node.append(el('strong', title), el('p', detail)); target.replaceChildren(node); }
function lazyDetail(title, build, className = 'record-detail') {
  const detail = el('details', null, className), summary = el('summary', title); detail.append(summary);
  let built = false;
  detail.addEventListener('toggle', () => { if (detail.open && !built) { built = true; build(detail); } });
  return detail;
}
function rawDetail(value) {
  const detail = lazyDetail('完整原始记录', node => node.append(el('pre', rawText(value))));
  detail.dataset.rawEvent = ''; return detail;
}
function appendParts(target, projection) {
  for (const note of projection.notes) target.append(el('div', note, 'record-note'));
  for (const part of projection.parts) {
    if (part.kind === 'text') target.append(markdown(part.text));
    else if (part.kind === 'attachment') {
      const card = el('div', null, 'record-attachment');
      card.append(el('strong', '▧  ' + part.title));
      const info = [part.mime, Number.isFinite(part.size) ? number(part.size) + ' 字节' : ''].filter(Boolean).join(' · ');
      card.append(el('small', (info ? info + '\n' : '') + '已保存附件引用；此阅读区不提供附件文件，也不会打开员工本地路径。'));
      card.append(lazyDetail('查看已存引用', node => node.append(el('pre', part.text)))); target.append(card);
    } else if (part.kind === 'code') target.append(el('pre', part.text, 'record-code'));
    else target.append(lazyDetail(part.title || '执行详情', node => node.append(part.kind === 'reasoning' ? markdown(part.text) : el('pre', part.text))));
  }
}
function eventNode(record, projection) {
  const article = el('article', null, 'record record-' + projection.kind + (projection.folded ? ' is-folded' : ''));
  article.dataset.eventSeq = String(record.seq); article.tabIndex = -1;
  article.dataset.technical = String(projection.kind === 'system');
  if (projection.folded) {
    const detail = lazyDetail('', node => { const body = el('div', null, 'record-content'); appendParts(body, projection); node.append(body); });
    detail.firstChild.append(el('span', projection.role), el('time', date(projection.time)));
    article.append(detail);
  } else {
    const heading = el('div', null, 'record-heading');
    heading.append(el('span', projection.kind === 'user' ? '员' : '助', 'record-avatar'), el('strong', projection.role), el('time', date(projection.time)));
    const body = el('div', null, 'record-content'); appendParts(body, projection); article.append(heading, body);
  }
  article.append(rawDetail(record.event)); return article;
}

function password() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz', digits = '23456789', all = letters + digits;
  const draw = alphabet => { const bytes = new Uint32Array(1); crypto.getRandomValues(bytes); return alphabet[bytes[0] % alphabet.length]; };
  let result = draw(letters) + draw(digits); while (result.length < 10) result += draw(all); return result;
}

export function createAdminCenter({ call, notice, getUser }) {
  let identity = '', active = false, epoch = 0, section = 'overview', users = [], mode = 'accounts';
  let usersTicket = 0, overviewTicket = 0, listTicket = 0, readTicket = 0, keyTicket = 0;
  let sessionList = [], cursor, total = 0, filters = {}, listBusy = false, selected = null;
  let records = [], projections = [], head = 0, next = 0, eventBusy = false, allLoading = false, stopAll = false;
  let matches = [], matchIndex = -1, overviewData = null;
  const tools = new Map(), cursors = new Set(), dialogs = new Set();
  const live = generation => active && generation === epoch && getUser()?.role === 'admin' && getUser()?.id === identity;
  const execute = async task => { const generation = epoch; try { return await task(); } catch (error) { if (live(generation)) notice(error.message); } };
  function status(id, message, retry, error = false) {
    const node = $(id); node.replaceChildren(el('span', message)); node.classList.toggle('is-error', error);
    if (retry) node.append(button('重试', () => execute(retry)));
  }
  function resetReader() {
    ++readTicket; stopAll = true; allLoading = false; eventBusy = false; selected = null; records = []; projections = []; head = next = 0; tools.clear();
    $('events').replaceChildren(); $('reader-content').hidden = true; $('reader-empty').hidden = false; $('events-error').hidden = true;
    $('reader-title').textContent = ''; $('reader-owner').textContent = ''; $('reader-meta').textContent = ''; $('event-find').value = '';
    $('chat-workspace').classList.remove('reading'); matches = []; matchIndex = -1; updateEventControls();
  }
  function deactivate() {
    active = false; ++epoch; ++usersTicket; ++overviewTicket; ++listTicket; ++readTicket; ++keyTicket; stopAll = true;
    allLoading = false; eventBusy = false; listBusy = false;
    $('api-key').value = ''; for (const modal of dialogs) modal.close(); dialogs.clear();
  }
  function syncIdentity(user) {
    const nextIdentity = user?.role === 'admin' ? user.id : '';
    if (identity === nextIdentity) return;
    deactivate(); identity = nextIdentity; users = []; sessionList = []; overviewData = null; cursor = undefined; total = 0; filters = {}; mode = 'accounts'; section = 'overview';
    for (const id of ['users','sessions','overview-stats','overview-users','overview-status','users-status','sessions-status']) $(id).replaceChildren();
    for (const id of ['chat-owner-search','chat-query','chat-from','chat-to','event-find','user-search','overview-from','overview-to']) $(id).value = '';
    $('chat-owner').replaceChildren(new Option('全部账号','')); $('user-role').value = ''; $('user-status').value = ''; $('key-status').textContent = '';
    resetReader();
  }
  async function go(name, load = true) {
    if (!live(epoch)) return; section = name;
    for (const item of ['overview','chat','accounts','settings']) $('admin-section-' + item).hidden = item !== name;
    for (const nav of $('admin-nav').querySelectorAll('button')) nav.setAttribute('aria-current', nav.dataset.section === name ? 'page' : 'false');
    if (name !== 'chat') stopAll = true;
    if (!load) return;
    if (name === 'overview') await loadOverview();
    if (name === 'chat' && !sessionList.length && !listBusy) await loadSessions(true);
    if (name === 'accounts') await loadUsers();
    if (name === 'settings') await loadKey();
  }
  async function open() {
    syncIdentity(getUser()); if (!identity) return;
    active = true; updateEventControls(); $('sessions-more').disabled = false;
    await Promise.all([loadUsers(), go(section)]);
  }
  for (const nav of $('admin-nav').querySelectorAll('button')) nav.onclick = () => execute(() => go(nav.dataset.section));

  function owner(id) { return users.find(user => user.id === id); }
  function ownerLabel(id) { const user = owner(id); return user ? (user.displayName || user.username) + (user.status === 'deleted' ? ' · ' + (user.purgedAt ? '聊天档案' : '回收站') : '') : '所属账号未载入'; }
  function ownerOptions() {
    const chosen = $('chat-owner').value, query = $('chat-owner-search').value.trim().toLocaleLowerCase();
    const rows = users.filter(user => user.id === chosen || [user.displayName,user.username,user.jobTitle].join(' ').toLocaleLowerCase().includes(query));
    $('chat-owner').replaceChildren(new Option(query ? '全部账号（不受账号搜索限制）' : '全部账号', ''));
    for (const user of rows) $('chat-owner').append(new Option((user.displayName || user.username) + ' · ' + user.username + (user.status === 'deleted' ? ' · 档案/回收站' : ''), user.id));
    $('chat-owner').value = rows.some(user => user.id === chosen) ? chosen : '';
  }
  $('chat-owner-search').oninput = ownerOptions;
  async function loadUsers() {
    const ticket = ++usersTicket, generation = epoch; status('users-status', '正在读取账号…');
    try {
      const value = await call('admin.users'); if (!live(generation) || ticket !== usersTicket) return;
      if (!Array.isArray(value?.users)) throw new Error('账号列表响应不完整。');
      users = value.users; $('users-status').replaceChildren(); renderUsers(); ownerOptions();
      if (overviewData) renderOverview(overviewData);
      if (selected) $('reader-owner').textContent = ownerLabel(selected.ownerId);
    } catch (error) { if (live(generation) && ticket === usersTicket) status('users-status', error.message, loadUsers, true); }
  }
  function filteredUsers() {
    const query = $('user-search').value.trim().toLocaleLowerCase(), role = $('user-role').value, state = $('user-status').value;
    return users.filter(user => recycleStatus(user).group === mode && (!role || user.role === role) && (mode !== 'accounts' || !state || user.status === state)
      && [user.username,user.displayName,user.jobTitle].join(' ').toLocaleLowerCase().includes(query));
  }
  function lastAdmin(user) { return user.role === 'admin' && user.status === 'active' && users.filter(value => value.role === 'admin' && value.status === 'active').length <= 1; }
  function renderUsers() {
    const rows = filteredUsers(); $('users').replaceChildren(); $('users-count').textContent = number(rows.length) + ' 个账号';
    for (const [name,id] of [['accounts','show-active-users'],['recycle','show-recycled-users'],['archive','show-archived-users']]) $(id).setAttribute('aria-pressed', String(mode === name));
    $('user-status').hidden = mode !== 'accounts';
    $('user-list-help').hidden = mode === 'accounts'; $('user-list-help').textContent = mode === 'recycle' ? '删除后保留 7 天。恢复后账号重新启用，所有旧登录保持失效。到期后只能查阅聊天档案。' : '账号已到期归档，不能恢复；已保存的聊天记录仍可查阅。';
    if (!rows.length) { empty($('users'), '没有符合条件的账号', mode === 'accounts' ? '调整筛选，或创建一个新账号。' : '此列表目前为空，可调整搜索条件。'); return; }
    for (const user of rows) {
      const row = el('div', null, 'account-row'); row.dataset.userId = user.id;
      const person = el('div', null, 'account-person'), name = el('div', user.displayName || user.username, 'account-name');
      name.append(el('small', '@' + user.username)); person.append(name, el('div', user.jobTitle || '职位未填写', 'account-job'));
      const recycled = recycleStatus(user); if (user.status === 'deleted') { const remaining = el('div', recycled.remaining, 'recycle-deadline'); remaining.title = user.purgeAfter ? '到期时间：' + date(user.purgeAfter) : ''; person.append(remaining); }
      const badges = el('div', null, 'account-badges');
      badges.append(el('span', user.role === 'admin' ? '管理' : '员工', 'subtle-badge'), el('span', user.status === 'active' ? '正常' : user.status === 'disabled' ? '已停用' : recycled.group === 'archive' ? '已归档' : '回收站', 'subtle-badge status-' + user.status));
      const actions = el('div', null, 'account-actions');
      actions.append(button('聊天记录', () => execute(async () => { $('chat-owner-search').value = ''; ownerOptions(); $('chat-owner').value = user.id; $('chat-query').value = ''; await go('chat', false); await searchSessions(); })));
      if (user.status !== 'deleted') {
        actions.append(button('编辑', () => accountDialog(user)));
        const more = el('details'), summary = el('summary', '•••'); summary.setAttribute('aria-label', '更多账号操作'); const menu = el('div', null, 'account-menu');
        const state = button(user.status === 'active' ? '停用账号' : '启用账号', () => execute(async () => {
          const actionGeneration = epoch;
          more.open = false; if (await confirm('确认' + (user.status === 'active' ? '停用' : '启用') + '账号', (user.displayName || user.username) + (user.status === 'active' ? '将退出所有设备并停止使用。' : '将恢复账号使用权限，旧登录不会恢复。'))) {
            await mutate('admin.updateUser', { id: user.id, status: user.status === 'active' ? 'disabled' : 'active' }, actionGeneration); notice('账号状态已更新。');
          }
        })); state.disabled = lastAdmin(user); if (state.disabled) state.title = '需保留最后一个启用的管理账号';
        menu.append(state, button('重置密码', () => { more.open = false; resetPasswordDialog(user); }));
        const remove = button('移入回收站', () => execute(async () => { more.open = false; const result = await mutate('admin.deleteUser', { id: user.id }); if (!result?.cancelled) notice('账号已移入回收站。'); }), 'danger');
        remove.disabled = user.id === identity || lastAdmin(user); if (remove.disabled) remove.title = '不能删除本人或最后一个启用的管理账号'; menu.append(remove); more.append(summary, menu); actions.append(more);
      } else if (recycled.group === 'recycle') {
        const restore = button('恢复账号', () => execute(async () => {
          const actionGeneration = epoch;
          if (await confirm('恢复账号', '恢复 ' + (user.displayName || user.username) + ' 后账号会启用，旧登录不会恢复。')) {
            restore.disabled = true; try { await mutate('admin.restoreUser', { id: user.id }, actionGeneration); notice('账号已恢复，请重新登录。'); } finally { if (active) await loadUsers(); }
          }
        })); restore.disabled = !recycled.recoverable; actions.append(restore);
      }
      row.append(el('span', (user.displayName || user.username || '?').slice(0,1), 'account-avatar'), person, badges, actions); $('users').append(row);
    }
  }
  async function mutate(action, value, generation = epoch) { if (!live(generation)) throw new Error('管理身份已失效。'); const result = await call(action, value); if (live(generation)) await loadUsers(); return result; }
  for (const id of ['user-search','user-role','user-status']) $(id).oninput = renderUsers;
  for (const [name,id] of [['accounts','show-active-users'],['recycle','show-recycled-users'],['archive','show-archived-users']]) $(id).onclick = () => { mode = name; renderUsers(); return loadUsers(); };
  $('refresh-users').onclick = loadUsers;
  $('new-account').onclick = () => accountDialog();
  window.setInterval(() => { if (active && section === 'accounts' && mode === 'recycle') void loadUsers(); }, 60_000);

  function modal(title, description) {
    const dialog = el('dialog', null, 'admin-dialog'), form = el('form'), heading = el('h2', title), error = el('div', '', 'dialog-error'), actions = el('div', null, 'dialog-actions');
    heading.id = 'modal-heading'; dialog.setAttribute('aria-labelledby', heading.id); error.setAttribute('role','alert');
    const cancel = button('取消', () => dialog.close()), submit = el('button', '确认', 'primary'); submit.type = 'submit';
    actions.append(cancel, submit); form.append(heading, el('p', description, 'dialog-description')); dialog.append(form); document.body.append(dialog); dialogs.add(dialog);
    const closed = [], nativeClose = dialog.close.bind(dialog); let cleaned = false;
    const cleanup = () => {
      if (cleaned) return; cleaned = true;
      for (const field of dialog.querySelectorAll('input')) field.value = '';
      for (const credential of dialog.querySelectorAll('.credential')) credential.textContent = '';
      dialog.remove(); dialogs.delete(dialog); for (const callback of closed) callback();
    };
    // The native close event may wait for a frame in a hidden/background window.
    // Clear credentials and detach synchronously, before opening the next dialog.
    dialog.close = value => { nativeClose(value); cleanup(); };
    dialog.addEventListener('close', cleanup);
    dialog.addEventListener('cancel', event => { event.preventDefault(); if (!submit.disabled) dialog.close(); });
    return { dialog, form, error, actions, submit, cancel, onClose: callback => closed.push(callback) };
  }
  function confirm(title, description) {
    const generation = epoch;
    return new Promise(resolve => { const m = modal(title, description); let accepted = false;
      m.form.append(m.actions); m.form.onsubmit = event => { event.preventDefault(); accepted = true; m.dialog.close(); };
      m.onClose(() => resolve(accepted && live(generation))); m.dialog.showModal(); m.cancel.focus();
    });
  }
  function field(form, title, id, value = '', type = 'text') {
    const label = el('label', title), input = el('input'); input.id = id; input.name = id; input.type = type; input.value = value; label.htmlFor = id; label.append(input); form.append(label); return input;
  }
  function deliverPassword(user, value, reset = false) {
    if (!active) return;
    const m = modal(reset ? '密码已重置' : '账号已创建', '请将登录信息交给对应员工。关闭后此处不再显示密码。');
    m.form.append(el('p', (user.displayName || user.username) + ' · ' + user.username), el('div', value, 'credential'));
    m.cancel.remove(); m.submit.textContent = '完成'; m.form.append(m.actions); m.form.onsubmit = event => { event.preventDefault(); m.dialog.close(); }; m.dialog.showModal();
  }
  function accountDialog(user) {
    const generation = epoch, m = modal(user ? '编辑账号' : '创建账号', user ? '更新姓名、职位与角色。服务器会保护最后一个启用的管理账号。' : '为同事创建公司账号，默认员工角色。初始密码已随机生成，也可以自行修改。');
    m.dialog.id = 'account-dialog'; m.form.id = 'account-form';
    const username = field(m.form, '账号', 'account-username', user?.username || ''); username.required = true; username.disabled = !!user; username.autocomplete = 'off';
    const displayName = field(m.form, '姓名', 'account-display-name', user?.displayName || ''); displayName.required = true; displayName.maxLength = 128;
    const jobTitle = field(m.form, '职位', 'account-job-title', user?.jobTitle || ''); jobTitle.maxLength = 100; jobTitle.placeholder = '选填';
    const label = el('label', '角色'), role = el('select'); role.id = 'account-role'; role.append(new Option('员工','employee'), new Option('管理','admin')); role.value = user?.role || 'employee'; label.append(role); m.form.append(label);
    let secret; if (!user) { secret = field(m.form,'初始密码','account-password',password(),'password'); secret.required = true; secret.minLength = 10; secret.maxLength = 128; secret.autocomplete = 'new-password'; m.form.append(el('p','创建成功后将显示初始密码，请妥善交付。','field-help')); }
    m.submit.id = 'account-submit'; m.submit.textContent = user ? '保存更改' : '创建账号'; m.form.append(m.error, m.actions);
    m.form.onsubmit = async event => {
      event.preventDefault(); if (m.submit.disabled || !live(generation)) return;
      if (user && lastAdmin(user) && role.value !== 'admin') { m.error.textContent = '需保留最后一个启用的管理账号。'; return; }
      m.submit.disabled = m.cancel.disabled = true; m.error.textContent = ''; let value = secret?.value || '';
      const payload = { ...(user ? { id: user.id } : { username: username.value.trim(), password: value }), displayName: displayName.value.trim(), jobTitle: jobTitle.value, role: role.value };
      try {
        const result = await mutate(user ? 'admin.updateUser' : 'admin.createUser', payload, generation);
        if (!live(generation)) return; m.dialog.close();
        if (user) notice('账号资料已更新。'); else deliverPassword(result.user || { ...payload, password: undefined }, value);
      } catch (error) { if (live(generation) && m.dialog.isConnected) m.error.textContent = error.message; }
      finally { value = ''; payload.password = ''; if (secret) secret.value = ''; m.submit.disabled = m.cancel.disabled = false; }
    };
    m.dialog.showModal(); (user ? displayName : username).focus();
  }
  function resetPasswordDialog(user) {
    const generation = epoch, m = modal('重置账号密码', '将重置 ' + (user.displayName || user.username) + ' 的密码。旧密码无法恢复，所有设备立即退出登录。');
    m.dialog.id = 'reset-password-dialog'; const secret = field(m.form,'新密码','reset-password-value',password(),'password'); secret.minLength = 10; secret.maxLength = 128; secret.required = true; secret.autocomplete = 'new-password';
    m.submit.textContent = '确认重置'; m.form.append(m.error,m.actions);
    m.form.onsubmit = async event => { event.preventDefault(); if (m.submit.disabled || !live(generation)) return;
      m.submit.disabled = m.cancel.disabled = true; let value = secret.value; secret.value = '';
      try { await mutate('admin.resetPassword', { id: user.id, password: value }, generation); if (live(generation)) { m.dialog.close(); deliverPassword(user,value,true); } }
      catch (error) { if (live(generation) && m.dialog.isConnected) m.error.textContent = error.message; }
      finally { value = ''; m.submit.disabled = m.cancel.disabled = false; }
    }; m.dialog.showModal(); m.cancel.focus();
  }

  async function loadOverview() {
    const generation = epoch, ticket = ++overviewTicket; status('overview-status','正在读取公司概览…'); $('overview-stats').replaceChildren(); $('overview-users').replaceChildren();
    try {
      const value = await call('admin.overview', dateRange($('overview-from').value,$('overview-to').value)); if (!live(generation) || ticket !== overviewTicket) return;
      if (!value?.accounts || !value.sessions || !value.usage || !Array.isArray(value.users)) throw new Error('概览响应不完整，请重试。');
      overviewData = value; $('overview-status').replaceChildren(); renderOverview(value);
    } catch (error) { if (live(generation) && ticket === overviewTicket) status('overview-status',unsupported(error) ? '服务器尚不支持公司概览，请更新服务器后重试。' : error.message,loadOverview,true); }
  }
  function renderOverview(value) {
    const { accounts:a, sessions:s, usage:u } = value; $('overview-stats').replaceChildren();
    const stats = [
      ['公司账号',a.total,'正常 ' + number(a.active) + ' · 停用 ' + number(a.disabled) + '\n回收站 ' + number(a.recycled) + ' · 归档 ' + number(a.archived)],
      ['保存的会话',s.total,'所选时间内更新 ' + number(s.updatedInRange) + ' 段'],
      ['模型请求',u.requests,'完成 ' + number(u.completed) + ' · 失败 ' + number(u.failed) + ' · 取消 ' + number(u.cancelled)],
      ['已报告 Tokens',u.totalTokens,'输入 ' + number(u.inputTokens) + ' · 输出 ' + number(u.outputTokens) + '\n缺少完整用量报告 ' + number(u.missingUsageRequests) + ' 次'],
    ];
    for (const [title,value,description] of stats) { const card = el('div',null,'stat-card'); card.append(el('span',title,'stat-label'),el('strong',number(value),'stat-value'),el('div',description,'stat-detail')); $('overview-stats').append(card); }
    const table = el('table',null,'admin-table'), thead = el('thead'), header = el('tr'); for (const text of ['账号','会话','请求','输入 Tokens','输出 Tokens','报告总 Tokens','用量缺失']) header.append(el('th',text)); thead.append(header); table.append(thead);
    const body = el('tbody'); for (const row of value.users) { const tr = el('tr'), name = el('td',ownerLabel(row.userId)); name.append(el('small',owner(row.userId)?.username || '')); tr.append(name); for (const key of ['sessions','requests','inputTokens','outputTokens','totalTokens','missingUsageRequests']) tr.append(el('td',number(row[key]))); body.append(tr); } table.append(body); $('overview-users').replaceChildren(table);
    if (!value.users.length) empty($('overview-users'),'暂无账号用量','数据将随实际使用显示，不估算或补齐缺失用量。');
  }
  $('overview-filters').onsubmit = event => { event.preventDefault(); void loadOverview(); }; $('overview-refresh').onclick = loadOverview;

  async function searchSessions() {
    try { filters = { ...dateRange($('chat-from').value,$('chat-to').value), ...($('chat-owner').value ? { ownerId: $('chat-owner').value } : {}), ...($('chat-query').value.trim() ? { q: $('chat-query').value.trim() } : {}) }; }
    catch (error) { status('sessions-status',error.message,undefined,true); return; }
    resetReader(); return loadSessions(true);
  }
  $('chat-filters').onsubmit = event => { event.preventDefault(); void searchSessions(); };
  $('chat-search-reset').onclick = () => { for (const id of ['chat-owner-search','chat-query','chat-from','chat-to']) $(id).value = ''; $('chat-owner').value = ''; ownerOptions(); return searchSessions(); };
  async function loadSessions(reset = false) {
    if (!live(epoch) || listBusy && !reset) return; const generation = epoch, ticket = ++listTicket;
    if (reset) { sessionList = []; cursor = undefined; total = 0; cursors.clear(); $('sessions').replaceChildren(); }
    listBusy = true; $('sessions-more').disabled = true; status('sessions-status','正在查询…');
    try {
      const value = await call('admin.querySessions', { ...filters, limit: 50, ...(cursor ? { cursor } : {}) });
      if (!live(generation) || ticket !== listTicket) return;
      if (!Array.isArray(value?.sessions) || !Number.isSafeInteger(value.total) || value.total < 0 || value.nextCursor != null && typeof value.nextCursor !== 'string') throw new Error('会话列表响应不完整。');
      if (value.nextCursor && (value.nextCursor === cursor || cursors.has(value.nextCursor))) throw new Error('会话分页未前进，请重新查询。');
      const byId = new Map(sessionList.map(item => [item.id,item]));
      for (const item of value.sessions) {
        if (typeof item?.id !== 'string' || typeof item.ownerId !== 'string' || !Number.isSafeInteger(item.nextSeq) || item.nextSeq < 0) throw new Error('会话信息不完整。');
        byId.set(item.id,item);
      }
      if (value.nextCursor && byId.size === sessionList.length) throw new Error('本页没有新的会话，请重试。');
      sessionList = [...byId.values()]; cursor = value.nextCursor || undefined; if (cursor) cursors.add(cursor); total = value.total;
      renderSessions(); status('sessions-status',sessionList.length + ' / ' + total); $('sessions-more').hidden = !cursor;
    } catch (error) {
      if (live(generation) && ticket === listTicket) {
        const message = unsupported(error) ? '服务器版本尚不支持完整记录查询，请更新服务器。未使用旧版前 100 条列表代替全库结果。' : error.message;
        status('sessions-status','查询未完成'); if (!sessionList.length) { empty($('sessions'),'暂时无法读取会话',message); $('sessions').append(button('重试查询',()=>loadSessions(true))); }
        else { const alert = el('div',message,'inline-error'); alert.append(button('重试本页',()=>loadSessions(false))); $('sessions').append(alert); }
      }
    } finally { if (live(generation) && ticket === listTicket) { listBusy = false; $('sessions-more').disabled = false; } }
  }
  function renderSessions() {
    $('sessions').replaceChildren();
    for (const item of sessionList) {
      const node = button('', () => openSession(item), 'session-row'); node.dataset.sessionId = item.id; node.setAttribute('aria-current', String(selected?.id === item.id));
      const sub = el('span',null,'session-description'); sub.append(el('span',ownerLabel(item.ownerId)),el('time',shortDate(item.updatedAt)));
      if (item.upstreamHeader?.origin === 'subagent') sub.prepend(el('span','子任务','subtask-label'));
      node.append(el('span',item.title || '未命名会话','session-name'),sub); node.title = (item.title || '未命名会话') + '\n' + date(item.updatedAt); $('sessions').append(node);
    }
    if (!sessionList.length) empty($('sessions'),'没有匹配的会话','调整账号、更新日期或关键词后再查询。');
  }
  $('sessions-more').onclick = () => loadSessions(false);
  async function openSession(item) {
    resetReader(); selected = item; head = item.nextSeq; stopAll = false; $('reader-empty').hidden = true; $('reader-content').hidden = false; $('chat-workspace').classList.add('reading');
    $('reader-title').textContent = (item.upstreamHeader?.origin === 'subagent' ? '子任务 · ' : '') + (item.title || '未命名会话'); $('reader-owner').textContent = ownerLabel(item.ownerId);
    $('reader-meta').textContent = '创建 ' + date(item.createdAt) + ' · 更新 ' + date(item.updatedAt);
    $('match-scope').textContent = (filters.q ? '全库关键词可匹配标题、尚未加载的记录或原始字段；下方查找仅限已加载内容。' : '按保存顺序只读展示。') + ' 技术记录可在“全部记录”中查看。';
    renderSessions(); await loadEvents();
  }
  function updateEventControls() {
    const complete = next >= head;
    $('events-status').textContent = records.length ? complete ? '已加载全部 ' + records.length + ' 条记录 · 已到当前末尾' : '已加载 ' + records.length + ' / ' + head + ' 条记录' : eventBusy ? '正在读取记录…' : selected ? '已加载 0 / ' + head + ' 条记录' : '';
    $('events-progress').max = Math.max(1,head); $('events-progress').value = next;
    $('more-events').hidden = complete && !eventBusy; $('all-events').hidden = complete || allLoading; $('stop-events').hidden = !allLoading;
    $('more-events').disabled = eventBusy || allLoading; $('all-events').disabled = eventBusy; $('stop-events').disabled = stopAll;
  }
  async function loadEvents() {
    if (!selected || eventBusy || !live(epoch)) return false;
    const generation = epoch, ticket = readTicket, id = selected.id; eventBusy = true; $('events-error').hidden = true; updateEventControls();
    try {
      const value = await call('admin.events',{ id, afterSeq: next - 1 }); if (!live(generation) || ticket !== readTicket || selected?.id !== id) return false;
      const page = appendEventPage(records,value);
      if (!records.length && page.added.length) $('events').replaceChildren();
      records = page.records; next = page.next; head = page.head;
      const fragment = document.createDocumentFragment();
      for (const record of page.added) { const projected = projectEvent(record.event,tools); projections.push(projected); const node = eventNode(record,projected); node.hidden = $('reader-mode').value !== 'all' && node.dataset.technical === 'true'; fragment.append(node); }
      $('events').append(fragment);
      if (!records.length) empty($('events'),'此会话暂无保存记录','这不会启动或继续员工任务。');
      updateMatches(false); return true;
    } catch (error) { if (live(generation) && ticket === readTicket) { $('events-error').textContent = error.message + ' 已加载内容保留，可继续加载重试。'; $('events-error').hidden = false; } return false; }
    finally { if (live(generation) && ticket === readTicket) { eventBusy = false; updateEventControls(); } }
  }
  $('more-events').onclick = loadEvents;
  $('all-events').onclick = async () => {
    if (allLoading || eventBusy || !selected) return; const generation = epoch, ticket = readTicket, target = head;
    allLoading = true; stopAll = false; updateEventControls();
    try {
      do { if (!await loadEvents()) break; await new Promise(resolve => setTimeout(resolve,0)); }
      while (live(generation) && ticket === readTicket && !stopAll && next < target);
    } finally { if (live(generation) && ticket === readTicket) { allLoading = false; updateEventControls(); if (stopAll) $('events-status').textContent += ' · 已停止继续加载'; } }
  };
  $('stop-events').onclick = () => { stopAll = true; $('stop-events').disabled = true; $('events-status').textContent += ' · 正在停止，当前页完成后保留已读内容'; };
  $('chat-back').onclick = () => $('chat-workspace').classList.remove('reading');
  function setReadMode() { for (const node of $('events').querySelectorAll('article')) node.hidden = $('reader-mode').value !== 'all' && node.dataset.technical === 'true'; }
  $('reader-mode').onchange = setReadMode;
  function updateMatches(reset = true) {
    const query = $('event-find').value.trim().toLocaleLowerCase(); matches = [];
    records.forEach((record,index) => { const matched = !!query && projections[index].raw.toLocaleLowerCase().includes(query); const node = $('events').querySelector('[data-event-seq="' + record.seq + '"]'); node?.classList.toggle('record-match',matched); if (matched) matches.push(record.seq); });
    if (reset || matchIndex >= matches.length) matchIndex = -1;
    $('event-find-count').textContent = query ? matches.length + ' 条已加载记录匹配' : '';
    $('event-find-prev').disabled = $('event-find-next').disabled = !matches.length;
    if (reset && matches.length) locateMatch(1);
  }
  async function locateMatch(direction) {
    if (!matches.length) return; matchIndex = (matchIndex + direction + matches.length) % matches.length;
    $('reader-mode').value = 'all'; setReadMode();
    for (const node of $('events').querySelectorAll('.record-current-match')) node.classList.remove('record-current-match');
    const node = $('events').querySelector('[data-event-seq="' + matches[matchIndex] + '"]'); if (!node) return;
    node.classList.add('record-current-match'); for (const detail of node.querySelectorAll('details')) detail.open = true;
    node.scrollIntoView({ block:'center' }); node.focus({ preventScroll:true });
    $('event-find-count').textContent = (matchIndex + 1) + ' / ' + matches.length + ' 条已加载记录';
  }
  $('event-find').oninput = () => updateMatches(); $('event-find-next').onclick = () => locateMatch(1); $('event-find-prev').onclick = () => locateMatch(-1);
  $('event-find').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); void locateMatch(event.shiftKey ? -1 : 1); } };

  function keyStatus(value) { if (typeof value?.configured !== 'boolean') throw new Error('服务状态响应不完整。'); $('key-status').textContent = value.configured ? '已配置 · ' + (value.updatedAt ? '更新于 ' + date(value.updatedAt) : '更新时间未记录') : '尚未配置 · 员工暂时无法调用模型'; }
  async function loadKey() {
    const generation = epoch, ticket = ++keyTicket; $('key-retry').hidden = true; $('key-status').textContent = '正在读取服务状态…';
    try { const value = await call('admin.deepseekStatus'); if (live(generation) && ticket === keyTicket) keyStatus(value); }
    catch (error) { if (live(generation) && ticket === keyTicket) { $('key-status').textContent = error.message; $('key-retry').hidden = false; } }
  }
  $('key-retry').onclick = loadKey;
  $('key-form').onsubmit = async event => { event.preventDefault(); if ($('save-key').disabled || !live(epoch)) return;
    const generation = epoch; ++keyTicket; let apiKey = $('api-key').value; $('api-key').value = ''; $('save-key').disabled = true;
    try { const value = await call('admin.saveDeepseekKey',{ apiKey }); if (live(generation)) { keyStatus(value); notice('密钥已保存到公司服务器。'); } }
    catch (error) { if (live(generation)) notice(error.message); }
    finally { apiKey = ''; $('save-key').disabled = false; }
  };
  return { open, deactivate, syncIdentity };
}

