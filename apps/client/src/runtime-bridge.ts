import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { CompanyApi } from './company-api.js';
import { CompanyError } from './types.js';
import type { AdminTools } from './admin-tools.js';
import type { PreferenceStore } from './preference-store.js';

const MODEL_ROUTES = new Set(['POST /deepseek/chat/completions', 'POST /deepseek/anthropic/v1/messages', 'POST /deepseek/search', 'POST /deepseek/fetch', 'GET /deepseek/models']);
export function allowedBridgeRoute(method: string, path: string): string | null {
  if (MODEL_ROUTES.has(`${method} ${path}`)) return `/gateway${path}`;
  if (/^\/deepseek\/anthropic\/v1\/files(?:\/[A-Za-z0-9_-]+)?(?:\?[a-z0-9_=&%-]+)?$/i.test(path) && ['GET', 'POST', 'DELETE'].includes(method)) return `/gateway${path}`;
  if (method === 'GET' && path === '/company/models') return '/models';
  if (method === 'GET' && path === '/company/account') return '/auth/me';
  const plain = path.split('?')[0];
  if (/^\/company\/sessions(?:\/[A-Za-z0-9_-]+)?(?:\/(?:events|lease))?$/.test(plain) && ['GET', 'POST', 'DELETE'].includes(method)) return path.slice('/company'.length);
  return null;
}

/** Loopback-only capability bridge. The runtime receives this ephemeral token, never company credentials. */
export class RuntimeBridge {
  readonly token = randomBytes(32).toString('base64url');
  #server: Server | null = null;
  #controllers = new Set<AbortController>();
  #origin = '';
  constructor(private readonly api: CompanyApi, private readonly adminTools?: AdminTools, private readonly preferences?: PreferenceStore) {}
  get origin(): string { if (!this.#origin) throw new Error('Bridge is not listening'); return this.#origin; }
  async start(): Promise<void> {
    this.#server = createServer((req, res) => { void this.handle(req, res); });
    this.#server.requestTimeout = 0;
    await new Promise<void>((resolve, reject) => {
      this.#server!.once('error', reject);
      this.#server!.listen(0, '127.0.0.1', () => resolve());
    });
    const address = this.#server.address();
    if (!address || typeof address === 'string') throw new Error('Invalid bridge address');
    this.#origin = `http://127.0.0.1:${address.port}`;
  }
  private async handle(req: IncomingMessage, res: ServerResponse) {
    const abort = new AbortController();
    this.#controllers.add(abort);
    res.on('close', () => { if (!res.writableFinished) abort.abort(); });
    try {
      // Web origins never receive access, including sites attempting to reach localhost.
      if (req.headers.origin || req.headers.host !== new URL(this.origin).host) throw new CompanyError('FORBIDDEN', '拒绝本机连接。', 403);
      const provided = String(req.headers['x-rufa-bridge'] ?? req.headers['x-api-key'] ?? req.headers.authorization?.replace(/^Bearer /i, '') ?? '');
      const supplied = Buffer.from(provided); const expected = Buffer.from(this.token);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new CompanyError('UNAUTHORIZED', '本机连接未授权。', 401);
      const path = req.url ?? '/'; const method = req.method ?? 'GET';
      const target = allowedBridgeRoute(method, path);
      const adminAction = method === 'POST' ? /^\/company\/admin-tools\/([a-z_]+)$/.exec(path)?.[1] : undefined;
      const preferenceAction = this.preferences && ({ 'GET /company/preferences/cache': 'snapshot', 'GET /company/preferences/history-local': 'history',
        'POST /company/preferences/local': 'mutate' } as Record<string, string>)[`${method} ${path}`];
      if (!target && !(adminAction && this.adminTools) && !preferenceAction) throw new CompanyError('ROUTE_NOT_ALLOWED', '此服务路径未开放。', 403);
      const parts: Buffer[] = []; let size = 0;
      for await (const part of req) {
        size += part.length;
        if (size > (adminAction || preferenceAction ? 16384 : 140 * 1024 * 1024)) throw new CompanyError('PAYLOAD_TOO_LARGE', '请求内容过大。', 413);
        parts.push(Buffer.from(part));
      }
      if (preferenceAction && this.preferences) {
        let input: unknown;
        if (preferenceAction === 'mutate') {
          try { input = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw new CompanyError('INVALID_INPUT', '无效的工作偏好参数。', 400); }
        }
        abort.signal.throwIfAborted();
        const result = preferenceAction === 'snapshot' ? this.preferences.snapshot() : preferenceAction === 'history' ? this.preferences.history() : await this.preferences.mutate(input, abort.signal);
        abort.signal.throwIfAborted();
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(result)); return;
      }
      if (adminAction && this.adminTools) {
        let value: unknown;
        try { value = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw new CompanyError('INVALID_INPUT', '无效的管理工具参数。', 400); }
        const interaction = req.headers['x-rufa-interaction'];
        const result = await this.adminTools.execute(adminAction, value, abort.signal, typeof interaction === 'string' ? interaction : undefined);
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(result)); return;
      }
      const headers = new Headers();
      for (const key of ['content-type', 'anthropic-version', 'anthropic-beta']) {
        const value = req.headers[key]; if (typeof value === 'string') headers.set(key, value);
      }
      const response = await this.api.authorizedFetch(target!, {
        method, headers, body: ['GET', 'HEAD'].includes(method) ? undefined : new Uint8Array(Buffer.concat(parts)), signal: abort.signal,
      });
      res.statusCode = response.status;
      for (const key of ['content-type', 'cache-control', 'retry-after']) {
        const value = response.headers.get(key); if (value) res.setHeader(key, value);
      }
      res.setHeader('x-content-type-options', 'nosniff');
      if (response.body) await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), res);
      else res.end();
    } catch (error) {
      if (!res.headersSent) {
        const known = error instanceof CompanyError;
        res.writeHead(known ? error.status ?? 502 : 502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: known ? error.code : 'COMPANY_UNAVAILABLE', message: known ? error.message : '无法连接公司服务器。' } }));
      } else res.destroy();
    } finally { this.#controllers.delete(abort); }
  }
  async stop(): Promise<void> {
    for (const controller of this.#controllers) controller.abort();
    this.#server?.closeAllConnections();
    if (this.#server) await new Promise<void>(resolve => this.#server!.close(() => resolve()));
    this.#server = null; this.#origin = '';
  }
}
