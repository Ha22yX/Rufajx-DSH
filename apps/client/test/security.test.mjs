import test from 'node:test';
import assert from 'node:assert/strict';
import { CompanyApi, normalizeServerUrl } from '../dist/company-api.js';
import { RuntimeBridge, allowedBridgeRoute } from '../dist/runtime-bridge.js';
import { enterpriseOverlay, sanitizedRuntimeEnvironment } from '../dist/harness-host.js';

const user = id => ({ id, username: id, displayName: id, role: 'employee' });
const login = (id = 'alice', expiry = 3600_000) => ({ user: user(id), deviceId: `device-${id}`, accessToken: `access-${id}`, refreshToken: `refresh-${id}`, expiresAt: new Date(Date.now() + expiry).toISOString() });
const json = value => Response.json(value);
const vault = () => ({ value: null, async read() { return this.value; }, async write(value) { this.value = value; }, async clear() { this.value = null; } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('production rejects insecure or arbitrary company endpoints before sending credentials', async () => {
  for (const input of ['http://example.com', 'https://x/path', 'https://user:password@x', 'https://x?url=evil']) assert.throws(() => normalizeServerUrl(input));
  assert.equal(normalizeServerUrl('http://127.0.0.1:8787', true), 'http://127.0.0.1:8787');
  let calls = 0;
  const saved = vault(); saved.value = { serverUrl: 'https://other.example', refreshToken: 'secret' };
  const api = new CompanyApi(saved, false, async () => { calls++; }, 'https://company.example');
  await assert.rejects(api.login('https://other.example', 'alice', 'pw'), { code: 'SERVER_NOT_ALLOWED' });
  await assert.rejects(api.restore(), { code: 'SERVER_NOT_ALLOWED' });
  assert.equal(calls, 0); assert.equal(saved.value, null);
});

test('concurrent requests rotate one refresh token, keep credentials out of public state, and omit empty JSON bodies', async () => {
  let refreshes = 0; const seen = []; const saved = vault();
  const api = new CompanyApi(saved, false, async (url, init) => {
    if (url.endsWith('/auth/login')) return json(login('alice', 1));
    if (url.endsWith('/auth/refresh')) { refreshes++; await new Promise(done => setTimeout(done, 10)); return json(login()); }
    seen.push(init); return new Response(null, { status: 204 });
  });
  await api.login('https://company.example', 'alice', 'pw');
  await Promise.all([api.json('DELETE', '/admin/users/test'), api.json('DELETE', '/admin/users/test2')]);
  assert.equal(refreshes, 1);
  for (const init of seen) { assert.equal(new Headers(init.headers).get('authorization'), 'Bearer access-alice'); assert.equal(new Headers(init.headers).get('content-type'), null); assert.equal(init.body, undefined); assert.equal(init.redirect, 'error'); }
  assert.equal(JSON.stringify(api.state).includes('access-alice'), false);
  assert.equal(JSON.stringify(api.state).includes('refresh-alice'), false);
  assert.deepEqual(saved.value, { serverUrl: 'https://company.example', refreshToken: 'refresh-alice' });
});

test('late refresh cannot resurrect a logged-out account or erase a newer account vault', async () => {
  const pending = deferred(); let refreshing = false; const saved = vault();
  const api = new CompanyApi(saved, false, async (url, init) => {
    if (url.endsWith('/auth/login')) return json(login(JSON.parse(init.body).username));
    if (url.endsWith('/auth/refresh')) { refreshing = true; return pending.promise; }
    return new Response(null, { status: 204 });
  });
  await api.login('https://company.example', 'alice', 'pw');
  const refresh = api.refresh(); const rejected = assert.rejects(refresh, { code: 'LOGIN_CANCELLED' });
  assert.ok(refreshing); await api.logout(); await api.login('https://company.example', 'bob', 'pw');
  pending.resolve(json(login('alice'))); await rejected;
  assert.equal(api.state.user.id, 'bob'); assert.equal(saved.value.refreshToken, 'refresh-bob');
});

test('late account A response is never delivered into account B', async () => {
  const pending = deferred();
  const api = new CompanyApi(vault(), false, async (url, init) => url.endsWith('/auth/login') ? json(login(JSON.parse(init.body).username)) : pending.promise);
  await api.login('https://company.example', 'alice', 'pw');
  const request = api.json('GET', '/sessions'); const rejected = assert.rejects(request, { code: 'LOGIN_CANCELLED' });
  await api.login('https://company.example', 'bob', 'pw');
  pending.resolve(json({ sessions: ['alice-private-session'] })); await rejected;
  assert.equal(api.state.user.id, 'bob');
});

test('revoked accounts lose cached credentials and error text cannot disclose server secrets', async () => {
  const saved = vault();
  const api = new CompanyApi(saved, false, async url => url.endsWith('/auth/login') ? json(login()) : Response.json({ error: { code: 'ACCOUNT_DISABLED', message: 'upstream-key-secret' } }, { status: 403 }));
  await api.login('https://company.example', 'alice', 'pw');
  await assert.rejects(api.verify(), error => error.code === 'ACCOUNT_DISABLED' && !error.message.includes('upstream-key-secret'));
  assert.equal(api.state.user, null); assert.equal(saved.value, null);
});

test('runtime bridge authenticates each call and exposes no admin or arbitrary proxy path', async () => {
  const seen = []; const bridge = new RuntimeBridge({ authorizedFetch: async (path, init) => { seen.push({ path, init }); return new Response('event: message\ndata: {}\n\n', { headers: { 'content-type': 'text/event-stream', 'set-cookie': 'forbidden' } }); } });
  await bridge.start();
  try {
    const path = `${bridge.origin}/deepseek/anthropic/v1/messages`;
    assert.equal((await fetch(path, { method: 'POST' })).status, 401);
    assert.equal((await fetch(path, { method: 'POST', headers: { 'x-api-key': bridge.token, origin: 'https://evil.example' } })).status, 403);
    assert.equal((await fetch(`${bridge.origin}/company/admin/users`, { headers: { 'x-rufa-bridge': bridge.token } })).status, 403);
    const response = await fetch(path, { method: 'POST', body: '{"model":"deepseek-flash"}', headers: { 'x-api-key': bridge.token, 'authorization': 'Bearer malicious', 'content-type': 'application/json', 'anthropic-beta': 'files-api-2025-04-14' } });
    assert.equal(response.status, 200); assert.ok((await response.text()).includes('event: message'));
    assert.equal(response.headers.get('set-cookie'), null); assert.equal(seen.length, 1);
    assert.equal(seen[0].path, '/gateway/deepseek/anthropic/v1/messages');
    assert.equal(seen[0].init.headers.get('authorization'), null); assert.equal(seen[0].init.headers.get('x-api-key'), null);
    assert.equal(seen[0].init.headers.get('anthropic-beta'), 'files-api-2025-04-14');
  } finally { await bridge.stop(); }
  for (const route of ['/company/auth/login', '/company/admin/users', '/deepseek/https://evil.example', '/company/sessions/../admin']) assert.equal(allowedBridgeRoute('POST', route), null);
});

test('runtime boot excludes inherited model keys and replaces original configurable providers', () => {
  assert.deepEqual(sanitizedRuntimeEnvironment({ PATH: 'tools', SYSTEMROOT: 'windows', DEEPSEEK_API_KEY: 'secret', NODE_OPTIONS: '--require evil', HTTP_PROXY: 'http://evil', RUFA_BRIDGE_TOKEN: 'old' }), { PATH: 'tools', SYSTEMROOT: 'windows' });
  const overlay = enterpriseOverlay('C:/runtime', 'deepseek-flash', ['deepseek-flash'], undefined, 'C:/account-a', 'C:/runtime');
  for (const id of ['credentials', 'llm-deepseek', 'llm-pi-ai', 'llm-deepseek-account', 'session-persistence-jsonl', 'web-deepseek-api']) assert.equal(overlay.find(row => row.id === id)?.disabled, true);
  const inserted = overlay.find(row => row.insert).insert;
  assert.ok(inserted.every(row => row.name.startsWith('file:')));
  for (const id of ['rufa-managed-policy', 'rufa-credentials', 'rufa-model', 'rufa-persistence', 'rufa-web', 'rufa-file-versions']) assert.equal(inserted.filter(row => row.id === id).length, 1);
  const badge = inserted.find(row => row.id === 'rufa-company-badge');
  assert.match(badge.name, /company-badge\.mjs$/); assert.match(badge.config.helperPath.replaceAll('\\', '/'), /node_modules\/@deepseek-ai\/dsh-skill-badge\/assets\/badge_metadata\.py$/);
  assert.equal(overlay.some(row => row.id === 'skill-badge'), false);
  assert.equal(inserted.some(row => row.id === 'rufa-auto-review'), true);
  assert.equal(inserted.some(row => row.id === 'rufa-admin-tools'), false);
});
