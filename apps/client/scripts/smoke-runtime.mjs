import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { CompanyApi } from '../dist/company-api.js';
import { HarnessHost } from '../dist/harness-host.js';
const root = resolve(process.argv[2] ?? process.env.RUFA_UPSTREAM_ROOT ?? 'C:/Users/Developer/AppData/Local/RufaDSH/development/upstream');
const temporary = await mkdtemp(join(tmpdir(), 'rufa-harness-smoke-'));
let requests = [];
const company = createServer(async (req, res) => {
  requests.push({ method: req.method, path: req.url });
  let body = ''; for await (const chunk of req) body += chunk;
  res.setHeader('content-type', 'application/json');
  const user = { id: 'smoke-user', username: 'smoke', displayName: '测试员工', role: 'employee' };
  if (req.url === '/api/v1/auth/login') return res.end(JSON.stringify({ user, accessToken: 'mock-access', refreshToken: 'mock-refresh', deviceId: 'mock-device', expiresAt: new Date(Date.now() + 3600_000).toISOString() }));
  if (req.headers.authorization !== 'Bearer mock-access') { res.statusCode = 401; return res.end('{}'); }
  if (req.url === '/api/v1/auth/me') return res.end(JSON.stringify({ user }));
  if (req.url === '/api/v1/models') return res.end(JSON.stringify({ gatewayBasePath: '/api/v1/gateway/deepseek', models: [{ id: 'deepseek-flash', displayName: '测试模型', inputModalities: ['text', 'image'] }] }));
  if (req.url.startsWith('/api/v1/sessions')) return res.end(JSON.stringify({ sessions: [] }));
  res.statusCode = 404; res.end(JSON.stringify({ error: { code: 'MOCK_ROUTE_UNAVAILABLE' } }));
});
await new Promise(resolve => company.listen(0, '127.0.0.1', resolve));
const vault = { read: async()=>null, write: async()=>{}, clear: async()=>{} };
const api = new CompanyApi(vault, true);
await api.login(`http://127.0.0.1:${company.address().port}`, 'smoke', 'not-a-real-password');
let diagnostics = '';
const host = new HarnessHost(api, { runtimeRoot: root, pluginRoot: process.argv[3] ? resolve(process.argv[3]) : fileURLToPath(new URL('../dist/runtime/', import.meta.url)), userRoot: temporary, execPath: process.execPath, electronMode: false, diagnostic: text => { diagnostics = (diagnostics + text).slice(-24_000); } });
try {
  const url = await host.start();
  const response = await fetch(url, { redirect: 'manual' });
  assert.ok([200, 302, 303].includes(response.status));
  assert.equal(host.state.status, 'running');
  assert.ok(requests.filter(item => item.path === '/api/v1/models').length >= 3, 'Both enterprise model and web providers must request the authenticated company catalog');
  console.log(JSON.stringify({ status: 'PASS', upstreamRoot: root, runtimeStarted: true, responseStatus: response.status, companyRequests: requests, paidModelCalls: 0 }, null, 2));
} catch (error) {
  await writeFile(join(temporary, 'startup-diagnostics.txt'), diagnostics);
  console.error(diagnostics);
  console.error(`FAILED: ${error.message}; diagnostics: ${join(temporary, 'startup-diagnostics.txt')}`);
  process.exitCode = 1;
} finally {
  await host.stop(); company.closeAllConnections(); await new Promise(resolve=>company.close(resolve));
  if (host.state.message) { console.error(diagnostics); console.error(`Shutdown unconfirmed: ${host.state.message}`); process.exitCode = 1; }
  else console.log('PASS: original Harness shutdown completed with persistence acknowledgement.');
}
