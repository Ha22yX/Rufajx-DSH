import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const bundle = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Pass the extracted server bundle directory.');
const temporary = await mkdtemp(join(tmpdir(), 'rufa-bundle-smoke-'));
const databasePath = join(temporary, 'company.sqlite');
const backupPath = join(temporary, 'backup.sqlite');
const password = randomBytes(24).toString('base64url');
const portProbe = createServer();
portProbe.listen(0, '127.0.0.1');
await once(portProbe, 'listening');
const port = portProbe.address().port;
await new Promise(resolveClose => portProbe.close(resolveClose));
const origin = `http://127.0.0.1:${port}`;
const env = { RUFA_DATABASE_DRIVER: 'sqlite', RUFA_DATABASE_PATH: databasePath, HOST: '127.0.0.1', PORT: String(port) };
for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'PATH']) if (process.env[key]) env[key] = process.env[key];
const execute = promisify(execFile);
const cli = (...args) => execute(process.execPath, [join(bundle, 'apps/server/dist/cli.js'), ...args], { cwd: bundle, env, windowsHide: true });
let child;
async function stop() {
  if (!child || child.exitCode !== null) return;
  const ended = once(child, 'exit'); child.kill(); await ended; child = undefined;
}
async function start() {
  child = spawn(process.execPath, [join(bundle, 'apps/server/dist/main.js')], { cwd: bundle, env, windowsHide: true, stdio: 'ignore' });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Packaged server exited before readiness.');
    try { const response = await fetch(`${origin}/health/ready`, { headers: { connection: 'close' }, signal: AbortSignal.timeout(500) }); if (response.ok) return; }
    catch { /* The startup probe is read-only. No mutations are retried. */ }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  }
  throw new Error('Packaged server did not become ready.');
}
async function json(path, method = 'GET', body, token) {
  const headers = { connection: 'close', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const response = await fetch(`${origin}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  assert(response.ok, `${method} ${path} returned ${response.status}`);
  return response.status === 204 ? undefined : response.json();
}
try {
  env.RUFA_BOOTSTRAP_USERNAME = 'bundle-manager';
  env.RUFA_BOOTSTRAP_DISPLAY_NAME = '打包验收';
  env.RUFA_BOOTSTRAP_PASSWORD = password;
  await cli('bootstrap-admin');
  await assert.rejects(cli('bootstrap-admin'));
  delete env.RUFA_BOOTSTRAP_PASSWORD;
  await start();
  const login = await json('/auth/login', 'POST', { username: 'bundle-manager', password });
  assert.deepEqual(await json('/admin/settings/deepseek', 'GET', undefined, login.accessToken), { configured: false, updatedAt: null });
  const settings = await json('/admin/settings/deepseek', 'PUT', { apiKey: 'sk-mock-bundle-settings-never-a-real-key' }, login.accessToken);
  assert.deepEqual(Object.keys(settings).sort(), ['configured', 'updatedAt']);
  assert.equal(settings.configured, true);
  const { session } = await json('/sessions', 'POST', { title: '安装包服务重启验收' }, login.accessToken);
  const lease = await json(`/sessions/${session.id}/lease`, 'POST', { deviceId: login.deviceId }, login.accessToken);
  const events = [
    { seq: 0, event: { seq: 0, type: 'message', data: { content: 'SQLite persistence from packaged server' } } },
    { seq: 1, event: { seq: 1, type: 'session/title', data: { title: '打包验收会话标题' } } },
  ];
  await json(`/sessions/${session.id}/events`, 'POST', { leaseId: lease.leaseId, expectedNextSeq: 0, events }, login.accessToken);
  const preferenceMutation = { mutationId: randomUUID(), operation: 'put', expectedVersion: 0, entry: {
    id: randomUUID(), scope: 'account', category: 'spreadsheet', topic: '金额显示', text: '金额显示两位小数', enabled: true,
    source: { sessionId: session.id, eventSeq: 0 },
  } };
  const preferenceSaved = await json('/preferences/mutations', 'POST', preferenceMutation, login.accessToken);
  assert.equal(preferenceSaved.snapshot.entries[0].text, '金额显示两位小数');
  await cli('backup', backupPath);
  await stop();
  await start();
  assert.equal((await json('/auth/me', 'GET', undefined, login.accessToken)).user.id, login.user.id);
  assert.deepEqual(await json('/admin/settings/deepseek', 'GET', undefined, login.accessToken), settings);
  assert.deepEqual((await json(`/sessions/${session.id}/events`, 'GET', undefined, login.accessToken)).events, events);
  assert.equal((await json(`/sessions/${session.id}`, 'GET', undefined, login.accessToken)).session.title, '打包验收会话标题');
  assert.deepEqual(await json('/preferences', 'GET', undefined, login.accessToken), preferenceSaved.snapshot);
  assert.deepEqual(await json('/preferences/mutations', 'POST', preferenceMutation, login.accessToken), preferenceSaved);
  assert.equal((await json('/preferences/history', 'GET', undefined, login.accessToken)).history[0].id, preferenceSaved.historyId);
  const snapshot = new DatabaseSync(backupPath, { readOnly: true });
  try {
    assert.equal(snapshot.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(snapshot.prepare('SELECT count(*) AS total FROM rufa_session_events').get().total, 2);
  } finally { snapshot.close(); }
  const secondLogin = await json('/auth/login', 'POST', { username: 'bundle-manager', password });
  const edited = await json('/auth/profile', 'PATCH', { displayName: '验收姓名', jobTitle: '项目主管' }, login.accessToken);
  assert.equal(edited.user.jobTitle, '项目主管');
  assert.equal((await json('/auth/me', 'GET', undefined, secondLogin.accessToken)).user.displayName, '验收姓名');
  const temporaryUser = await json('/admin/users', 'POST', { username: 'recycle-smoke', displayName: '回收验收', jobTitle: '  研发  ', password: 'Abcde12345', role: 'employee' }, login.accessToken);
  assert.equal(temporaryUser.user.jobTitle, '研发');
  const updatedJob = await json(`/admin/users/${temporaryUser.user.id}`, 'PATCH', { jobTitle: '技术主管' }, login.accessToken);
  assert.equal(updatedJob.user.jobTitle, '技术主管');
  await stop(); await start();
  assert.equal((await json('/admin/users', 'GET', undefined, login.accessToken)).users.find(user => user.id === temporaryUser.user.id).jobTitle, '技术主管');
  await json(`/admin/users/${temporaryUser.user.id}`, 'DELETE', undefined, login.accessToken);
  const trashUser = (await json('/admin/users', 'GET', undefined, login.accessToken)).users.find(user => user.id === temporaryUser.user.id);
  assert.equal(trashUser.status, 'deleted'); assert.ok(trashUser.purgeAfter); assert.equal(trashUser.purgedAt, null);
  const recovered = await json(`/admin/users/${temporaryUser.user.id}/restore`, 'POST', undefined, login.accessToken);
  assert.equal(recovered.user.status, 'active'); assert.equal(recovered.user.purgeAfter, null);
  const nextPassword = randomBytes(24).toString('base64url');
  await json('/auth/change-password', 'POST', { currentPassword: password, newPassword: nextPassword }, login.accessToken);
  for (const token of [login.accessToken, secondLogin.accessToken]) {
    const expired = await fetch(`${origin}/api/v1/auth/me`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(expired.status, 401);
    await expired.arrayBuffer();
  }
  const changedLogin = await json('/auth/login', 'POST', { username: 'bundle-manager', password: nextPassword });
  assert.deepEqual((await json(`/sessions/${session.id}/events`, 'GET', undefined, changedLogin.accessToken)).events, events);
  await json('/auth/logout', 'POST', {}, changedLogin.accessToken);
  console.log('Packaged server verified: bootstrap, HTTP login, key save/status/restart, event persistence, backup, profile editing, preference save/restart/idempotency/history, ten-character initial password, recycle and restore, password change, all-device logout and intact session history. No model API called.');
} finally {
  await stop();
  assert.equal(dirname(resolve(temporary)), resolve(tmpdir()));
  assert(basename(temporary).startsWith('rufa-bundle-smoke-'));
  await rm(temporary, { recursive: true, force: true });
}
