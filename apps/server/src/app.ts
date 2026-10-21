import { randomUUID } from 'node:crypto';
import Fastify, { LogController, type FastifyReply, type FastifyRequest } from 'fastify';
import { GatewayAdmission } from './admission.js';
import { registerClientUpdates } from './client-updates.js';
import { ACCOUNT_CLEANUP_INTERVAL_MS } from './account-lifecycle.js';
import { parseAdminRange, parseAdminSessionQuery } from './admin-queries.js';
import { DeepSeekSettings } from './deepseek-settings.js';
import { normalizeModelCatalog, type ServerConfig } from './config.js';
import { Gateway } from './gateway.js';
import { assertPreferenceQueryEmpty, parsePreferenceHistoryQuery, parsePreferenceMutation, PreferenceConflict, type PreferenceAccess } from './preferences.js';
import { hashPassword, makeToken, normalizeUsername, tokenHash, validatePassword, verifyPassword } from './security.js';
import type { SessionAccess, Store } from './store.js';
import { AppError, invalid, managedUser, notFound, publicUser, unauthorized, type AuthContext, type Role, type StoredEvent } from './types.js';

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
};
const string = (value: unknown, max: number, field: string) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw invalid(`${field} 格式无效`);
  return value;
};
const jobTitle = (value: unknown) => {
  if (typeof value !== 'string' || value.length > 100) throw invalid('职位必须为至多100个字符的文本，可留空');
  return value.trim();
};
const role = (value: unknown): Role => { if (value !== 'employee' && value !== 'admin') throw invalid('角色无效'); return value; };
const integer = (value: unknown, min: number, max: number) => {
  if (typeof value === 'string' && !/^-?\d+$/.test(value)) throw invalid();
  const number = typeof value === 'string' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < min || number > max) throw invalid('序号或分页参数无效');
  return number;
};
const resourceId = (value: unknown) => { const id = string(value, 128, 'ID'); if (!/^[a-zA-Z0-9_.-]+$/.test(id)) throw invalid('ID 格式无效'); return id; };
const uuid = (value: unknown) => { const id = resourceId(value); if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw notFound(); return id; };

export function buildApp(store: Store, config: ServerConfig, readiness: () => Promise<void> = async () => {}, secretSettings?: DeepSeekSettings) {
  // Normalize programmatic configurations too, without mutating the caller's object.
  config = { ...config, models: normalizeModelCatalog(config.models, config.maxOutputTokens) };
  const app = Fastify({ bodyLimit: config.bodyLimitBytes, logger: config.logger ? { redact: ['req.headers.authorization', 'req.headers["x-api-key"]'] } : false, logController: new LogController({ disableRequestLogging: true }), genReqId: () => randomUUID(), requestTimeout: 30_000 });
  const now = () => new Date((config.now ?? Date.now)()).toISOString();
  const sessionAccess = (auth: AuthContext): SessionAccess => ({ userId: auth.user.id, loginId: auth.login.id, accessHash: auth.login.accessHash, now });
  let cleanupTask: Promise<void> | undefined;
  let cleanupTimer: ReturnType<typeof setInterval> | undefined;
  const cleanup = () => cleanupTask ??= store.purgeExpiredUsers(now()).then(() => {}).finally(() => { cleanupTask = undefined; });
  app.addHook('onReady', async () => {
    await cleanup();
    cleanupTimer = setInterval(() => { void cleanup().catch(() => app.log.error({ code: 'ACCOUNT_PURGE_FAILED' }, 'Account cleanup failed')); }, ACCOUNT_CLEANUP_INTERVAL_MS);
    cleanupTimer.unref();
  });
  app.addHook('onClose', async () => { if (cleanupTimer) clearInterval(cleanupTimer); await cleanupTask; });
  const settings = secretSettings ?? DeepSeekSettings.environmentOnly(config.upstreamKey);
  const gateway = new Gateway(store, config, settings);
  const admission = new GatewayAdmission(config);
  app.addContentTypeParser(/^multipart\/form-data(?:;|$)/, { parseAs: 'buffer', bodyLimit: config.bodyLimitBytes }, (_request, body, done) => done(null, body));
  let kdfActive = 0;
  async function kdf<T>(work: () => Promise<T>): Promise<T> {
    if (kdfActive >= 4) throw new AppError(429, 'AUTH_BUSY', '登录服务繁忙，请稍后重试');
    kdfActive++;
    try { return await work(); } finally { kdfActive--; }
  }
  const limits = new Map<string, { count: number; expires: number }>();
  function rateLimit(key: string, max: number) {
    const time = (config.now ?? Date.now)();
    if (limits.size > 2000) for (const [id, entry] of limits) if (entry.expires <= time) limits.delete(id);
    if (limits.size >= 10000 && !limits.has(key)) throw new AppError(429, 'RATE_LIMITED', '请求频率过高，请稍后重试');
    let entry = limits.get(key);
    if (!entry || entry.expires <= time) { entry = { count: 0, expires: time + 300_000 }; limits.set(key, entry); }
    if (++entry.count > max) throw new AppError(429, 'RATE_LIMITED', '请求频率过高，请稍后重试');
  }
  async function audit(request: FastifyRequest, actorId: string | null, action: string, targetId?: string) {
    await store.audit({ id: randomUUID(), actorId, action, targetId, requestId: request.id, createdAt: now() });
  }
  async function authenticate(request: FastifyRequest, admin = false): Promise<AuthContext> {
    const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/i.exec(request.headers.authorization ?? '');
    if (!match) throw unauthorized();
    const auth = await store.resolveAccess(tokenHash(match[1]), now());
    if (!auth) throw unauthorized();
    if (admin && auth.user.role !== 'admin') throw new AppError(403, 'FORBIDDEN', '需要管理权限');
    return auth;
  }
  async function owned(request: FastifyRequest) {
    const auth = await authenticate(request);
    const id = resourceId(record(request.params).id);
    const session = await store.getSession(id);
    if (!session || session.ownerId !== auth.user.id) throw notFound();
    return { auth, session };
  }
  async function admitGateway(request: FastifyRequest, reply: FastifyReply) {
    try {
      const auth = await authenticate(request);
      const filesList = request.routeOptions.url === '/api/v1/gateway/deepseek/anthropic/v1/files' && request.method === 'GET';
      if (!filesList) admission.enter(request, reply, auth.user.id, request.method === 'POST' && request.routeOptions.url === '/api/v1/gateway/deepseek/anthropic/v1/files');
    } catch (error) {
      // An early rejection must not keep an unread request body on a keep-alive socket.
      reply.header('Connection', 'close');
      throw error;
    }
  }
  function tokens() {
    const accessToken = makeToken(); const refreshToken = makeToken();
    const time = (config.now ?? Date.now)();
    const expiresAt = new Date(time + config.accessTtlMs).toISOString();
    return { accessToken, refreshToken, expiresAt, rotation: { accessHash: tokenHash(accessToken), refreshHash: tokenHash(refreshToken), accessExpiresAt: expiresAt, refreshExpiresAt: new Date(time + config.refreshTtlMs).toISOString() } };
  }
  async function list(ownerId: string, query: Record<string, unknown>) {
    const limit = integer(query.limit ?? 100, 1, 1000);
    const cursor = query.cursor === undefined ? undefined : resourceId(query.cursor);
    const all = await store.listSessions(ownerId, limit + 1, cursor);
    const sessions = all.slice(0, limit);
    return { sessions, ...(all.length > limit ? { nextCursor: sessions.at(-1)!.id } : {}) };
  }
  async function events(id: string, query: Record<string, unknown>) {
    return store.readEventPage(id, integer(query.afterSeq ?? -1, -1, Number.MAX_SAFE_INTEGER), integer(query.limit ?? 500, 1, 1000));
  }
  app.addHook('onSend', async (_request, reply) => { reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff'); });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof PreferenceConflict) return reply.code(error.status).send({ error: { code: error.code, message: error.message, requestId: request.id }, snapshot: error.snapshot });
    if (error instanceof AppError) return reply.code(error.status).send({ error: { code: error.code, message: error.message, requestId: request.id } });
    const known = error as { code?: string; statusCode?: number };
    if (known.statusCode === 413) return reply.code(413).send({ error: { code: 'PAYLOAD_TOO_LARGE', message: '请求超过服务端大小限制，请分批提交', requestId: request.id } });
    if (known.statusCode && known.statusCode >= 400 && known.statusCode < 500) return reply.code(known.statusCode).send({ error: { code: 'INVALID_REQUEST', message: '请求格式无效', requestId: request.id } });
    // Never serialize database errors, request bodies or upstream exceptions.
    app.log.error({ requestId: request.id, code: 'INTERNAL_ERROR' }, 'Request failed');
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: '服务暂时不可用', requestId: request.id } });
  });
  app.setNotFoundHandler((request, reply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: '接口不存在', requestId: request.id } }));
  app.get('/health/live', async () => ({ status: 'ok' }));
  registerClientUpdates(app, config.clientReleasesDir ?? 'data/client-releases', config.clientUpdatePublicKeyFile);
  app.get('/health/ready', async (_request, reply) => { try { await readiness(); return { status: 'ok' }; } catch { return reply.code(503).send({ status: 'unavailable' }); } });

  app.post('/api/v1/auth/login', async request => {
    rateLimit(`ip:${request.ip}`, 60);
    const body = record(request.body);
    const username = normalizeUsername(body.username);
    rateLimit(`user:${username}`, 15);
    const password = string(body.password, 128, '密码');
    const user = await store.findUser(username);
    const valid = await kdf(() => verifyPassword(password, user?.passwordHash));
    if (!valid || !user || user.status !== 'active') { await audit(request, null, 'auth.login.failed'); throw unauthorized(); }
    const result = tokens();
    const auth = await store.createLogin({ id: randomUUID(), userId: user.id, deviceId: randomUUID(), deviceLabel: body.deviceLabel === undefined ? 'Windows 客户端' : string(body.deviceLabel, 128, '设备名称'), ...result.rotation, revokedAt: null, createdAt: now() }, user.passwordHash);
    await audit(request, user.id, 'auth.login', auth.login.id);
    return { accessToken: result.accessToken, refreshToken: result.refreshToken, expiresAt: result.expiresAt, deviceId: auth.login.deviceId, user: publicUser(auth.user) };
  });
  app.post('/api/v1/auth/refresh', async request => {
    rateLimit(`refresh:${request.ip}`, 120);
    const body = record(request.body);
    const token = string(body.refreshToken, 256, '续期凭据');
    const result = tokens();
    const auth = await store.rotateRefresh(tokenHash(token), result.rotation, now());
    if (!auth) throw unauthorized();
    return { accessToken: result.accessToken, refreshToken: result.refreshToken, expiresAt: result.expiresAt, deviceId: auth.login.deviceId, user: publicUser(auth.user) };
  });
  app.post('/api/v1/auth/logout', async (request, reply) => {
    const auth = await authenticate(request); await store.revokeLogin(auth.login.id); await audit(request, auth.user.id, 'auth.logout', auth.login.id); return reply.code(204).send();
  });
  app.get('/api/v1/auth/me', async request => ({ user: publicUser((await authenticate(request)).user) }));
  async function preferenceAccess(request: FastifyRequest): Promise<PreferenceAccess> {
    const auth = await authenticate(request);
    return { userId: auth.user.id, loginId: auth.login.id, accessHash: auth.login.accessHash, now, requestId: request.id };
  }
  app.get('/api/v1/preferences', async request => {
    const access = await preferenceAccess(request); assertPreferenceQueryEmpty(request.query);
    return store.getPreferences(access);
  });
  app.get('/api/v1/preferences/history', async request => {
    const access = await preferenceAccess(request);
    return store.getPreferenceHistory(access, parsePreferenceHistoryQuery(request.query));
  });
  app.post('/api/v1/preferences/mutations', { bodyLimit: 8192, onRequest: async request => { await authenticate(request); } }, async request => {
    const access = await preferenceAccess(request); assertPreferenceQueryEmpty(request.query);
    return store.mutatePreferences(access, parsePreferenceMutation(request.body));
  });
  app.patch('/api/v1/auth/profile', { bodyLimit: 4096, onRequest: async request => { await authenticate(request); } }, async request => {
    const auth = await authenticate(request);
    const body = record(request.body);
    if (Object.keys(body).length !== 2 || !Object.hasOwn(body, 'displayName') || !Object.hasOwn(body, 'jobTitle')) throw invalid('只允许提交姓名和职位');
    const displayName = string(body.displayName, 128, '姓名').trim();
    const title = jobTitle(body.jobTitle);
    const time = now();
    const user = await store.updateProfile({ userId: auth.user.id, loginId: auth.login.id, accessHash: auth.login.accessHash,
      displayName, jobTitle: title, now: time,
      audit: { id: randomUUID(), actorId: auth.user.id, action: 'auth.profile.update', requestId: request.id, createdAt: time } });
    return { user: publicUser(user) };
  });
  app.post('/api/v1/auth/change-password', { bodyLimit: 4096, onRequest: async request => { await authenticate(request); } }, async (request, reply) => {
    const auth = await authenticate(request);
    const body = record(request.body);
    if (Object.keys(body).length !== 2 || !Object.hasOwn(body, 'currentPassword') || !Object.hasOwn(body, 'newPassword')) throw invalid('只允许提交原密码和新密码');
    const currentPassword = string(body.currentPassword, 128, '原密码');
    validatePassword(body.newPassword);
    const newPassword = body.newPassword;
    rateLimit(`change-password:${auth.user.id}`, 15);
    const passwordHash = await kdf(async () => {
      if (!await verifyPassword(currentPassword, auth.user.passwordHash)) {
        await audit(request, auth.user.id, 'auth.password.change.failed');
        throw new AppError(400, 'INVALID_CURRENT_PASSWORD', '原密码不正确');
      }
      return hashPassword(newPassword);
    });
    const time = now();
    // KDF runs outside DB locks; the store compares the observed hash and rechecks
    // the exact login inside the same transaction as revocation and success audit.
    await store.changePassword({ userId: auth.user.id, loginId: auth.login.id, accessHash: auth.login.accessHash,
      expectedPasswordHash: auth.user.passwordHash, passwordHash, now: time,
      audit: { id: randomUUID(), actorId: auth.user.id, action: 'auth.password.change', requestId: request.id, createdAt: time } });
    return reply.code(204).send();
  });
  const adminSettingsOptions = { bodyLimit: 8192, onRequest: async (request: FastifyRequest) => { await authenticate(request, true); } };
  app.get('/api/v1/admin/settings/deepseek', adminSettingsOptions, async request => {
    const auth = await authenticate(request, true);
    await audit(request, auth.user.id, 'admin.settings.deepseek.read');
    return settings.status();
  });
  app.put('/api/v1/admin/settings/deepseek', adminSettingsOptions, async request => {
    const auth = await authenticate(request, true);
    const body = record(request.body);
    if (Object.keys(body).length !== 1 || !Object.hasOwn(body, 'apiKey')) throw invalid('只允许提交 API Key');
    // Audit the requested change before writing; an audit failure cannot produce
    // an error response after the key has already changed. No key enters the DB.
    await audit(request, auth.user.id, 'admin.settings.deepseek.update.requested');
    return settings.update(body.apiKey);
  });
  app.get('/api/v1/models', async request => { await authenticate(request); return { models: config.models, gatewayBasePath: '/api/v1/gateway/deepseek' }; });
  app.get('/api/v1/gateway/deepseek/models', async request => { await authenticate(request); return { object: 'list', data: config.models.map(model => ({ id: model.id, object: 'model', owned_by: 'company' })) }; });
  app.post('/api/v1/gateway/deepseek/chat/completions', { onRequest: admitGateway }, async (request, reply) => gateway.completion(request, reply, await authenticate(request)));
  app.post('/api/v1/gateway/deepseek/anthropic/v1/messages', { onRequest: admitGateway }, async (request, reply) => gateway.completion(request, reply, await authenticate(request), 'messages'));
  app.post('/api/v1/gateway/deepseek/search', { onRequest: admitGateway }, async (request, reply) => gateway.completion(request, reply, await authenticate(request), 'search'));
  app.post('/api/v1/gateway/deepseek/fetch', { onRequest: admitGateway }, async (request, reply) => gateway.completion(request, reply, await authenticate(request), 'fetch'));
  app.route({ method: ['GET', 'POST'], url: '/api/v1/gateway/deepseek/anthropic/v1/files', bodyLimit: config.fileUploadLimitBytes, onRequest: admitGateway, handler: async (request, reply) => gateway.files(request, reply, await authenticate(request)) });
  app.route({ method: ['GET', 'DELETE'], url: '/api/v1/gateway/deepseek/anthropic/v1/files/:id', onRequest: admitGateway, handler: async (request, reply) => gateway.files(request, reply, await authenticate(request), resourceId(record(request.params).id)) });

  app.get('/api/v1/sessions', async request => list((await authenticate(request)).user.id, record(request.query)));
  app.post('/api/v1/sessions', async (request, reply) => {
    const auth = await authenticate(request); const body = record(request.body);
    const session = await store.createSession(auth.user.id, { id: body.id === undefined ? undefined : resourceId(body.id), title: body.title === undefined ? undefined : string(body.title, 500, '标题'), workspaceRef: body.workspaceRef === undefined ? undefined : string(body.workspaceRef, 4096, '工作区'), upstreamHeader: body.upstreamHeader, inheritedEventCount: body.inheritedEventCount === undefined ? 0 : integer(body.inheritedEventCount, 0, Number.MAX_SAFE_INTEGER) });
    return reply.code(201).send({ session });
  });
  app.get('/api/v1/sessions/:id', async request => ({ session: (await owned(request)).session }));
  app.get('/api/v1/sessions/:id/events', async request => { const { session } = await owned(request); return events(session.id, record(request.query)); });
  app.post('/api/v1/sessions/:id/lease', async request => {
    const { auth, session } = await owned(request); const body = record(request.body);
    if (body.deviceId !== auth.login.deviceId) throw new AppError(403, 'DEVICE_MISMATCH', '设备与当前登录不匹配');
    return store.acquireLease(session.id, sessionAccess(auth), config.leaseTtlMs);
  });
  app.delete('/api/v1/sessions/:id/lease', async (request, reply) => {
    const { auth, session } = await owned(request); const body = record(request.body);
    await store.releaseLease(session.id, sessionAccess(auth), uuid(body.leaseId)); return reply.code(204).send();
  });
  app.post('/api/v1/sessions/:id/events', async request => {
    const { auth, session } = await owned(request); const body = record(request.body);
    const expectedNextSeq = integer(body.expectedNextSeq, 0, Number.MAX_SAFE_INTEGER);
    if (!Array.isArray(body.events) || body.events.length < 1 || body.events.length > 1000 || !Number.isSafeInteger(expectedNextSeq + body.events.length)) throw invalid('每批须包含1至1000条事件');
    const batch: StoredEvent[] = body.events.map((value, index) => {
      const item = record(value);
      if (integer(item.seq, 0, Number.MAX_SAFE_INTEGER) !== expectedNextSeq + index || item.event === null || typeof item.event !== 'object' || Array.isArray(item.event)) throw invalid('事件必须按连续序号提交，并保留完整事件对象');
      return { seq: item.seq as number, event: item.event };
    });
    return { nextSeq: await store.appendEvents(session.id, sessionAccess(auth), uuid(body.leaseId), expectedNextSeq, batch) };
  });

  app.get('/api/v1/admin/users', async request => { const auth = await authenticate(request, true); await store.purgeExpiredUsers(now()); await audit(request, auth.user.id, 'admin.users.read'); return { users: (await store.listUsers()).map(managedUser) }; });
  app.post('/api/v1/admin/users', async (request, reply) => {
    const auth = await authenticate(request, true); const body = record(request.body);
    validatePassword(body.password, 10);
    const input = { username: normalizeUsername(body.username), displayName: string(body.displayName, 128, '显示名称'), jobTitle: body.jobTitle === undefined ? '' : jobTitle(body.jobTitle), role: role(body.role), passwordHash: await kdf(() => hashPassword(body.password as string, 10)) };
    const user = await store.createUser(input); await audit(request, auth.user.id, 'admin.user.create', user.id); return reply.code(201).send({ user: managedUser(user) });
  });
  app.patch('/api/v1/admin/users/:id', async request => {
    const auth = await authenticate(request, true); const body = record(request.body); const id = uuid(record(request.params).id);
    if (body.status !== undefined && body.status !== 'active' && body.status !== 'disabled') throw invalid('账号状态无效');
    if (body.displayName === undefined && body.jobTitle === undefined && body.role === undefined && body.status === undefined) throw invalid('没有需要更新的字段');
    const user = await store.updateUser(id, { displayName: body.displayName === undefined ? undefined : string(body.displayName, 128, '显示名称'), jobTitle: body.jobTitle === undefined ? undefined : jobTitle(body.jobTitle), role: body.role === undefined ? undefined : role(body.role), status: body.status as 'active' | 'disabled' | undefined });
    await audit(request, auth.user.id, 'admin.user.update', id); return { user: managedUser(user) };
  });
  app.post('/api/v1/admin/users/:id/reset-password', async (request, reply) => {
    const auth = await authenticate(request, true); const body = record(request.body); const id = uuid(record(request.params).id); validatePassword(body.password, 10);
    await store.resetPassword(id, await kdf(() => hashPassword(body.password as string, 10))); await audit(request, auth.user.id, 'admin.user.reset-password', id); return reply.code(204).send();
  });
  app.delete('/api/v1/admin/users/:id', async (request, reply) => {
    const auth = await authenticate(request, true); const id = uuid(record(request.params).id);
    const time = now();
    await store.deleteUser({ userId: auth.user.id, loginId: auth.login.id, accessHash: auth.login.accessHash, now: time, targetId: id,
      audit: { id: randomUUID(), actorId: auth.user.id, action: 'admin.user.delete', targetId: id, requestId: request.id, createdAt: time } });
    return reply.code(204).send();
  });
  app.post('/api/v1/admin/users/:id/restore', async request => {
    const auth = await authenticate(request, true); const id = uuid(record(request.params).id);
    if (request.body !== undefined && Object.keys(record(request.body)).length) throw invalid('恢复账号不接受额外字段');
    const time = now(); await store.purgeExpiredUsers(time);
    const user = await store.restoreUser({ userId: auth.user.id, loginId: auth.login.id, accessHash: auth.login.accessHash, now: time, targetId: id,
      audit: { id: randomUUID(), actorId: auth.user.id, action: 'admin.user.restore', targetId: id, requestId: request.id, createdAt: time } }, now);
    return { user: managedUser(user) };
  });
  app.get('/api/v1/admin/sessions', async request => {
    const auth = await authenticate(request, true), query = parseAdminSessionQuery(request.query);
    await audit(request, auth.user.id, 'admin.sessions.query', query.ownerId);
    const result = await store.queryAdminSessions(query);
    // Long content scans must not return records after the caller was revoked.
    await authenticate(request, true);
    return result;
  });
  app.get('/api/v1/admin/overview', async request => {
    const auth = await authenticate(request, true), range = parseAdminRange(request.query);
    await audit(request, auth.user.id, 'admin.overview.read');
    const result = await store.getAdminOverview(range, now());
    await authenticate(request, true);
    return result;
  });
  app.get('/api/v1/admin/users/:id/sessions', async request => {
    const auth = await authenticate(request, true); const id = uuid(record(request.params).id);
    await audit(request, auth.user.id, 'admin.sessions.read', id); return list(id, record(request.query));
  });
  app.get('/api/v1/admin/sessions/:id/events', async request => {
    const auth = await authenticate(request, true); const id = resourceId(record(request.params).id);
    await audit(request, auth.user.id, 'admin.session.events.read', id); return events(id, record(request.query));
  });
  return app;
}
