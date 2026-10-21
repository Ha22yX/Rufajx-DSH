// Test double only. Production uses SQLite by default, or the optional PostgresStore.
import { randomUUID } from 'node:crypto';
import type { AccountMutation, PasswordChange, ProfileChange, SessionAccess, Store } from '../src/store.js';
import { isDeepStrictEqual } from 'node:util';
import { ARCHIVED_DISPLAY_NAME, purgeDeadline } from '../src/account-lifecycle.js';
import { eventDigest } from '../src/security.js';
import { latestSessionTitle } from '../src/session-title.js';
import { adminSessionPage, emptyAdminUsage, jsonSearchText, type AdminOverview, type AdminRange, type AdminSessionQuery } from '../src/admin-queries.js';
import { applyPreference, emptyPreferences, preferenceHistoryPage, preferenceRecord, replayPreference, type PreferenceAccess, type PreferenceHistoryQuery, type PreferenceMutation, type PreferenceRecord, type PreferenceSnapshot } from '../src/preferences.js';
import { AppError, notFound, unauthorized, type Audit, type AuthContext, type Lease, type Login, type NewSession, type Role, type SessionSummary, type StoredEvent, type TokenRotation, type UpstreamFile, type Usage, type User } from '../src/types.js';

const copy = <T>(value: T): T => structuredClone(value);
export class MemoryStore implements Store {
  readonly preferences = new Map<string, PreferenceSnapshot>();
  readonly preferenceReceipts = new Map<string, PreferenceRecord>();
  private preferenceActor(access: PreferenceAccess) {
    const time = access.now(), user = this.users.get(access.userId), login = this.logins.get(access.loginId);
    if (!user || user.status !== 'active' || !login || login.userId !== access.userId || login.revokedAt || login.accessHash !== access.accessHash || login.accessExpiresAt <= time) throw unauthorized();
    return time;
  }
  async getPreferences(access: PreferenceAccess) { this.preferenceActor(access); return copy(this.preferences.get(access.userId) ?? emptyPreferences()); }
  async getPreferenceHistory(access: PreferenceAccess, query: PreferenceHistoryQuery) {
    this.preferenceActor(access);
    const history = [...this.preferenceReceipts.entries()].filter(([key]) => key.startsWith(`${access.userId}:`)).map(([, receipt]) => receipt.history).filter(row => row.revision < (query.beforeRevision ?? Number.MAX_SAFE_INTEGER)).sort((a, b) => b.revision - a.revision);
    return copy(preferenceHistoryPage(history, query.limit));
  }
  async mutatePreferences(access: PreferenceAccess, mutation: PreferenceMutation) {
    const time = this.preferenceActor(access), snapshot = this.preferences.get(access.userId) ?? emptyPreferences();
    const key = `${access.userId}:${mutation.mutationId}`, saved = this.preferenceReceipts.get(key);
    if (saved) {
      const history = [...this.preferenceReceipts.entries()].filter(([id, row]) => id.startsWith(`${access.userId}:`) && row.history.revision <= saved.history.revision).map(([, row]) => row.history).sort((a, b) => a.revision - b.revision);
      return copy(replayPreference(saved, mutation, snapshot, history));
    }
    if (mutation.operation === 'put' && mutation.entry.source && this.sessions.get(mutation.entry.source.sessionId)?.ownerId !== access.userId) throw notFound();
    const receipt = applyPreference(snapshot, mutation, time);
    this.preferences.set(access.userId, copy(receipt.result.snapshot)); this.preferenceReceipts.set(key, copy(preferenceRecord(receipt)));
    this.audits.push({ id: randomUUID(), actorId: access.userId, action: `preferences.${mutation.operation}`, targetId: receipt.history.id, requestId: access.requestId, createdAt: time });
    return copy(receipt.result);
  }
  readonly users = new Map<string, User>();
  readonly logins = new Map<string, Login>();
  readonly spentRefresh = new Map<string, string>();
  readonly sessions = new Map<string, SessionSummary>();
  readonly eventLogs = new Map<string, StoredEvent[]>();
  readonly leases = new Map<string, Lease & { loginId: string }>();
  readonly audits: Audit[] = [];
  readonly usages: Usage[] = [];
  readonly files = new Map<string, UpstreamFile>();
  readonly fileContents = new Map<string, Buffer>();
  async findUser(username: string) { return copy([...this.users.values()].find(user => user.username === username)); }
  async listUsers() { return copy([...this.users.values()]); }
  async createUser(input: { username: string; displayName: string; jobTitle?: string; role: Role; passwordHash: string }, bootstrap = false) {
    if (bootstrap && this.users.size) throw new AppError(409, 'ALREADY_INITIALIZED', '系统已初始化');
    if ([...this.users.values()].some(user => user.username === input.username)) throw new AppError(409, 'USERNAME_EXISTS', '账号已存在');
    const user: User = { ...input, jobTitle: input.jobTitle ?? '', id: randomUUID(), status: 'active', createdAt: new Date().toISOString(), deletedAt: null, purgeAfter: null, purgedAt: null };
    this.users.set(user.id, user); return copy(user);
  }
  async updateUser(id: string, patch: { displayName?: string; jobTitle?: string; role?: Role; status?: 'active' | 'disabled' | 'deleted' }) {
    const user = this.users.get(id); if (!user || user.status === 'deleted') throw notFound();
    const next = { ...user, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) } as User;
    if (next.status === 'deleted') { next.deletedAt = new Date().toISOString(); next.purgeAfter = purgeDeadline(next.deletedAt); }
    if (user.role === 'admin' && user.status === 'active' && (next.role !== 'admin' || next.status !== 'active') && [...this.users.values()].filter(value => value.role === 'admin' && value.status === 'active').length <= 1) throw new AppError(409, 'LAST_ADMIN', '必须保留至少一个启用的管理账号');
    this.users.set(id, next);
    if (next.role !== user.role || next.status !== 'active') this.revokeUser(id);
    return copy(next);
  }
  private revokeUser(id: string) { for (const value of this.logins.values()) if (value.userId === id) value.revokedAt = new Date().toISOString(); }
  async resetPassword(id: string, passwordHash: string) { const user = this.users.get(id); if (!user || user.status === 'deleted') throw notFound(); user.passwordHash = passwordHash; this.revokeUser(id); }
  async changePassword(change: PasswordChange) {
    const user = this.users.get(change.userId), login = this.logins.get(change.loginId);
    if (!user || user.status !== 'active' || !login || login.userId !== change.userId || login.revokedAt || login.accessHash !== change.accessHash || login.accessExpiresAt <= change.now) throw unauthorized();
    if (user.passwordHash !== change.expectedPasswordHash) throw new AppError(400, 'INVALID_CURRENT_PASSWORD', '原密码已变化，请重新输入');
    const entry = copy(change.audit);
    user.passwordHash = change.passwordHash;
    for (const value of this.logins.values()) if (value.userId === user.id && !value.revokedAt) value.revokedAt = change.now;
    this.audits.push(entry);
  }
  async updateProfile(change: ProfileChange): Promise<User> {
    const user = this.users.get(change.userId), login = this.logins.get(change.loginId);
    if (!user || user.status !== 'active' || !login || login.userId !== change.userId || login.revokedAt || login.accessHash !== change.accessHash || login.accessExpiresAt <= change.now) throw unauthorized();
    const entry = copy(change.audit);
    user.displayName = change.displayName; user.jobTitle = change.jobTitle;
    this.audits.push(entry);
    return copy(user);
  }
  private accountActor(change: AccountMutation) {
    const user = this.users.get(change.userId), login = this.logins.get(change.loginId);
    if (!user || user.status !== 'active' || !login || login.userId !== change.userId || login.revokedAt || login.accessHash !== change.accessHash || login.accessExpiresAt <= change.now) throw unauthorized();
    if (user.role !== 'admin') throw new AppError(403, 'FORBIDDEN', '需要管理权限');
  }
  async deleteUser(change: AccountMutation): Promise<User> {
    this.accountActor(change);
    if (change.targetId === change.userId) throw new AppError(400, 'SELF_DELETE_NOT_ALLOWED', '不能删除当前登录的管理账号');
    const user = this.users.get(change.targetId); if (!user) throw notFound();
    if (user.status === 'deleted') return copy(user);
    if (user.role === 'admin' && user.status === 'active' && [...this.users.values()].filter(value => value.role === 'admin' && value.status === 'active').length <= 1) throw new AppError(409, 'LAST_ADMIN', '必须保留至少一个启用的管理账号');
    user.status = 'deleted'; user.deletedAt = change.now; user.purgeAfter = purgeDeadline(change.now); user.purgedAt = null;
    for (const login of this.logins.values()) if (login.userId === user.id && !login.revokedAt) login.revokedAt = change.now;
    this.audits.push(copy(change.audit)); return copy(user);
  }
  async restoreUser(change: AccountMutation, clock?: () => string): Promise<User> {
    change = { ...change, now: clock?.() ?? change.now };
    this.accountActor(change);
    const user = this.users.get(change.targetId); if (!user) throw notFound();
    if (user.purgedAt || (user.status === 'deleted' && (!user.purgeAfter || user.purgeAfter <= change.now))) throw new AppError(409, 'RESTORE_EXPIRED', '账号恢复期限已过，聊天档案仍保留');
    if (user.status !== 'deleted') throw new AppError(409, 'USER_NOT_DELETED', '账号不在回收站中');
    user.status = 'active'; user.deletedAt = null; user.purgeAfter = null;
    this.audits.push(copy(change.audit)); return copy(user);
  }
  async purgeExpiredUsers(now: string): Promise<number> {
    const expired = [...this.users.values()].filter(user => user.status === 'deleted' && !user.purgedAt && user.purgeAfter && user.purgeAfter <= now);
    for (const user of expired) {
      this.preferences.delete(user.id);
      for (const key of this.preferenceReceipts.keys()) if (key.startsWith(`${user.id}:`)) this.preferenceReceipts.delete(key);
      const ids = new Set([...this.logins.values()].filter(login => login.userId === user.id).map(login => login.id));
      for (const [hash, loginId] of this.spentRefresh) if (ids.has(loginId)) this.spentRefresh.delete(hash);
      for (const [id, lease] of this.leases) if (ids.has(lease.loginId)) this.leases.delete(id);
      for (const id of ids) {
        if (!this.usages.some(usage => usage.loginId === id)) { this.logins.delete(id); continue; }
        Object.assign(this.logins.get(id)!, { accessHash: `purged-access:${id}`, refreshHash: `purged-refresh:${id}`, deviceId: '00000000-0000-0000-0000-000000000000', deviceLabel: '', accessExpiresAt: now, refreshExpiresAt: now, revokedAt: this.logins.get(id)!.revokedAt ?? now });
      }
      user.passwordHash = ''; user.displayName = ARCHIVED_DISPLAY_NAME; user.jobTitle = ''; user.role = 'employee'; user.purgedAt = now;
      this.audits.push({ id: randomUUID(), actorId: null, action: 'system.user.purge', targetId: user.id, createdAt: now });
    }
    return expired.length;
  }
  async createLogin(value: Login, expectedPasswordHash: string): Promise<AuthContext> {
    const user = this.users.get(value.userId);
    if (!user || user.status !== 'active' || user.passwordHash !== expectedPasswordHash) throw unauthorized();
    this.logins.set(value.id, copy(value)); return { user: copy(user), login: copy(value) };
  }
  async resolveAccess(hash: string, now: string): Promise<AuthContext | undefined> {
    const login = [...this.logins.values()].find(value => value.accessHash === hash && !value.revokedAt && value.accessExpiresAt > now);
    const user = login && this.users.get(login.userId);
    return login && user?.status === 'active' ? copy({ user, login }) : undefined;
  }
  async resolveLogin(id: string, now: string): Promise<AuthContext | undefined> {
    const login = this.logins.get(id); const user = login && this.users.get(login.userId);
    return login && !login.revokedAt && login.refreshExpiresAt > now && user?.status === 'active' ? copy({ user, login }) : undefined;
  }
  async rotateRefresh(hash: string, rotation: TokenRotation, now: string): Promise<AuthContext | undefined> {
    const login = [...this.logins.values()].find(value => value.refreshHash === hash);
    if (!login) { const previous = this.spentRefresh.get(hash); if (previous) { const found = this.logins.get(previous); if (found) found.revokedAt = now; } return undefined; }
    const user = this.users.get(login.userId);
    if (!user || user.status !== 'active' || login.revokedAt || login.refreshExpiresAt <= now) return undefined;
    this.spentRefresh.set(hash, login.id); Object.assign(login, rotation); return copy({ user, login });
  }
  async revokeLogin(id: string) { const login = this.logins.get(id); if (login) login.revokedAt = new Date().toISOString(); }
  async createSession(ownerId: string, input: NewSession) {
    const id = input.id ?? randomUUID(); const existing = this.sessions.get(id);
    if (existing) {
      if (existing.ownerId !== ownerId) throw new AppError(409, 'SESSION_ID_CONFLICT', '会话标识已被使用');
      if ((input.upstreamHeader !== undefined && eventDigest(input.upstreamHeader) !== eventDigest(existing.upstreamHeader)) || (input.inheritedEventCount !== undefined && input.inheritedEventCount !== existing.inheritedEventCount)) throw new AppError(409, 'SESSION_HEADER_CONFLICT', '会话创建元数据不一致');
      return copy(existing);
    }
    const createdAt = new Date().toISOString();
    const value: SessionSummary = { ...copy(input), id, ownerId, title: input.title ?? '新会话', nextSeq: 0, createdAt, updatedAt: createdAt, inheritedEventCount: input.inheritedEventCount ?? 0 };
    this.sessions.set(id, value); this.eventLogs.set(id, []); return copy(value);
  }
  async listSessions(ownerId: string, limit: number, cursor?: string) { return copy([...this.sessions.values()].filter(value => value.ownerId === ownerId && (!cursor || value.id > cursor)).sort((a, b) => a.id.localeCompare(b.id)).slice(0, limit)); }
  async queryAdminSessions(query: AdminSessionQuery) {
    // Match SQLite LIKE's ASCII case folding, without treating SQL wildcards as patterns.
    const fold = (value: string) => value.replace(/[A-Z]/g, letter => letter.toLowerCase());
    const all = [...this.sessions.values()].filter(row => (!query.ownerId || row.ownerId === query.ownerId) && (!query.from || row.updatedAt >= query.from) && (!query.to || row.updatedAt < query.to)
      && (!query.q || fold(row.title).includes(fold(query.q)) || (this.eventLogs.get(row.id) ?? []).some(item => fold(JSON.stringify(item.event)).includes(fold(jsonSearchText(query.q!))))))
      .sort((a, b) => a.updatedAt === b.updatedAt ? (a.id === b.id ? 0 : a.id > b.id ? -1 : 1) : a.updatedAt > b.updatedAt ? -1 : 1);
    const rows = all.filter(row => !query.cursor || row.updatedAt < query.cursor.updatedAt || (row.updatedAt === query.cursor.updatedAt && row.id < query.cursor.id)).slice(0, query.limit + 1);
    return copy(adminSessionPage(rows, all.length, query));
  }
  async getAdminOverview(range: AdminRange, now: string): Promise<AdminOverview> {
    const inRange = (value: string) => (!range.from || value >= range.from) && (!range.to || value < range.to);
    const accounts = { total: this.users.size, active: 0, disabled: 0, recycled: 0, archived: 0 };
    for (const user of this.users.values()) {
      if (user.status === 'active' || user.status === 'disabled') accounts[user.status]++;
      else accounts[user.purgedAt || !user.purgeAfter || user.purgeAfter <= now ? 'archived' : 'recycled']++;
    }
    const usage = emptyAdminUsage(), byUser = new Map<string, ReturnType<typeof emptyAdminUsage>>();
    for (const entry of this.usages.filter(row => inRange(row.createdAt))) {
      const user = byUser.get(entry.userId) ?? emptyAdminUsage(); byUser.set(entry.userId, user);
      for (const item of [usage, user]) {
        item.requests++; item[entry.status]++;
        item.inputTokens += entry.inputTokens ?? 0; item.outputTokens += entry.outputTokens ?? 0; item.totalTokens += entry.totalTokens ?? 0;
        if (entry.inputTokens === null || entry.outputTokens === null || entry.totalTokens === null) item.missingUsageRequests++;
      }
    }
    const sessions = [...this.sessions.values()];
    return { accounts, sessions: { total: sessions.length, updatedInRange: sessions.filter(row => inRange(row.updatedAt)).length }, usage,
      users: [...this.users.keys()].sort().map(userId => { const { requests, inputTokens, outputTokens, totalTokens, missingUsageRequests } = byUser.get(userId) ?? emptyAdminUsage(); return { userId, sessions: sessions.filter(row => row.ownerId === userId).length, requests, inputTokens, outputTokens, totalTokens, missingUsageRequests }; }),
    };
  }
  async getSession(id: string) { return copy(this.sessions.get(id)); }
  async readEvents(id: string, afterSeq: number, limit: number) { return copy((this.eventLogs.get(id) ?? []).filter(value => value.seq > afterSeq).slice(0, limit)); }
  async readEventPage(id: string, afterSeq: number, limit: number) {
    const session = this.sessions.get(id); if (!session) throw notFound();
    return copy({ nextSeq: session.nextSeq, events: (this.eventLogs.get(id) ?? []).filter(value => value.seq > afterSeq && value.seq < session.nextSeq).slice(0, limit) });
  }
  private sessionForWrite(id: string, access: SessionAccess) {
    const user = this.users.get(access.userId), login = this.logins.get(access.loginId), session = this.sessions.get(id), now = access.now();
    if (!user || user.status !== 'active' || !login || login.userId !== access.userId || login.revokedAt || login.accessHash !== access.accessHash || login.accessExpiresAt <= now) throw unauthorized();
    if (!session || session.ownerId !== access.userId) throw notFound();
    return { session, now };
  }
  async acquireLease(id: string, access: SessionAccess, ttlMs: number): Promise<Lease> {
    const { session, now } = this.sessionForWrite(id, access), loginId = access.loginId, expiresAt = new Date(Date.parse(now) + ttlMs).toISOString();
    const existing = this.leases.get(id);
    if (existing && existing.expiresAt > now && existing.loginId !== loginId && !this.logins.get(existing.loginId)?.revokedAt) throw new AppError(409, 'LEASE_CONFLICT', '会话正在其他设备上运行');
    const lease = { leaseId: existing && existing.loginId === loginId && existing.expiresAt > now ? existing.leaseId : randomUUID(), loginId, expiresAt, nextSeq: session.nextSeq };
    this.leases.set(id, lease); const { loginId: _, ...publicLease } = lease; return copy(publicLease);
  }
  async releaseLease(id: string, access: SessionAccess, leaseId: string) {
    this.sessionForWrite(id, access); const loginId = access.loginId;
    const lease = this.leases.get(id); if (!lease || lease.loginId !== loginId || lease.leaseId !== leaseId) throw new AppError(409, 'LEASE_LOST', '会话写入租约已失效');
    this.leases.delete(id);
  }
  async appendEvents(id: string, access: SessionAccess, leaseId: string, expectedNextSeq: number, events: StoredEvent[]) {
    const { session, now } = this.sessionForWrite(id, access), loginId = access.loginId;
    const lease = this.leases.get(id);
    if (!lease || lease.loginId !== loginId || lease.leaseId !== leaseId || lease.expiresAt <= now) throw new AppError(409, 'LEASE_LOST', '会话写入租约已失效');
    const previous = this.eventLogs.get(id)!;
    if (expectedNextSeq !== session.nextSeq) {
      if (expectedNextSeq < session.nextSeq && expectedNextSeq + events.length <= session.nextSeq && events.every((value, i) => isDeepStrictEqual(value.event, previous[expectedNextSeq + i].event))) return session.nextSeq;
      throw new AppError(409, 'SEQUENCE_CONFLICT', '会话序号冲突，请重新读取服务端记录');
    }
    previous.push(...copy(events)); session.nextSeq += events.length; session.updatedAt = now; session.title = latestSessionTitle(events) ?? session.title; return session.nextSeq;
  }
  async audit(entry: Audit) { this.audits.push(copy(entry)); }
  async recordUsage(entry: Usage) { this.usages.push(copy(entry)); }
  async saveFile(file: UpstreamFile, contents: Buffer) { if (this.files.has(file.id)) throw new Error('duplicate file'); this.files.set(file.id, copy(file)); this.fileContents.set(file.id, Buffer.from(contents)); }
  async getFile(id: string) { return copy(this.files.get(id)); }
  async listFiles(ownerId: string, limit: number, afterId?: string) { return copy([...this.files.values()].filter(file => file.ownerId === ownerId && !file.deletedAt && (!afterId || file.id > afterId)).sort((a, b) => a.id.localeCompare(b.id)).slice(0, limit)); }
  async markFileDeleted(id: string) { const file = this.files.get(id); if (file) file.deletedAt = new Date().toISOString(); }
  async close() {}
}
