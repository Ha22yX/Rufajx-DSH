import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function importUpstream(name) {
  const root = process.env.RUFA_RUNTIME_ROOT;
  if (!root) throw new Error('RUFA_RUNTIME_ROOT is required');
  const bases = [
    join(root, 'package.json'), join(root, 'apps/cli/package.json'),
    join(root, 'packages/bundle/base/package.json'), join(root, 'packages/session/session-persistence-jsonl/package.json'),
    join(root, 'packages/credentials/credentials-local/package.json'),
  ];
  for (const base of [...bases]) {
    try {
      const req = createRequire(base);
      for (const owner of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-session-persistence-jsonl', '@deepseek-ai/dsh-credentials-local']) {
        try { bases.push(req.resolve(`${owner}/package.json`)); } catch { /* This root may not own that dependency. */ }
      }
    } catch { /* Try the next known package root. */ }
  }
  for (const base of bases) {
    try { return await import(pathToFileURL(createRequire(base).resolve(name)).href); }
    catch (error) { if (!['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND'].includes(error.code)) throw error; }
  }
  throw new Error(`The pinned runtime does not resolve ${name}`);
}

export function bridgeConfig() {
  const origin = process.env.RUFA_BRIDGE_ORIGIN;
  const token = process.env.RUFA_BRIDGE_TOKEN;
  const deviceId = process.env.RUFA_DEVICE_ID;
  if (!origin || !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin) || !token || !deviceId) throw new Error('Enterprise bridge bootstrap missing');
  return { origin, token, deviceId };
}

export async function companyRequest(method, path, body, signal, internalHeaders = {}) {
  const { origin, token } = bridgeConfig();
  const response = await fetch(`${origin}/company${path}`, {
    method, headers: { ...internalHeaders, 'x-rufa-bridge': token, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal,
  });
  if (!response.ok) {
    let code = `HTTP_${response.status}`;
    try { const data = await response.json(); if (/^[A-Z0-9_]+$/.test(data.error?.code)) code = data.error.code; } catch { /* Safe fallback. */ }
    const error = new Error(`Company service refused ${method} ${path.split('?')[0]} (${code})`);
    error.code = code; error.status = response.status; throw error;
  }
  return response.status === 204 ? undefined : response.json();
}
