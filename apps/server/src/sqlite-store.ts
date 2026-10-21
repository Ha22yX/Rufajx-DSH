import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { backup, DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { eventDigest } from './security.js';
import { matchesSessionEvent, sessionEventDigest } from './session-events.js';
import { latestSessionTitle } from './session-title.js';
import { adminOverviewResult, adminOverviewSql, adminSessionPage, adminSessionSql, type AdminRange, type AdminSessionQuery } from './admin-queries.js';
import { applyPreference, emptyPreferences, preferenceHistoryPage, preferenceRecord, replayPreference, type PreferenceAccess, type PreferenceHistoryQuery, type PreferenceMutation, type PreferenceRecord, type PreferenceSnapshot } from './preferences.js';
import type { AccountMutation, PasswordChange, ProfileChange, SessionAccess, Store } from './store.js';
import { ARCHIVED_DISPLAY_NAME, purgeDeadline } from './account-lifecycle.js';
import { AppError, notFound, unauthorized, type Audit, type AuthContext, type Lease, type Login, type NewSession, type Role, type SessionSummary, type StoredEvent, type TokenRotation, type UpstreamFile, type Usage, type User } from './types.js';

type Row = Record<string, any>;
const utc = () => new Date().toISOString();
const asUser = (row: Row): User => ({ id: row.id, username: row.username, displayName: row.display_name, jobTitle: row.job_title, role: row.role, status: row.status, passwordHash: row.password_hash, createdAt: row.created_at, deletedAt: row.deleted_at, purgeAfter: row.purge_after, purgedAt: row.purged_at });
const asLogin = (row: Row): Login => ({ id: row.id, userId: row.user_id, deviceId: row.device_id, deviceLabel: row.device_label, accessHash: row.access_hash, refreshHash: row.refresh_hash, accessExpiresAt: row.access_expires_at, refreshExpiresAt: row.refresh_expires_at, revokedAt: row.revoked_at, createdAt: row.created_at });
const asSession = (row: Row): SessionSummary => ({ id: row.id, ownerId: row.owner_id, title: row.title, nextSeq: row.next_seq, inheritedEventCount: row.inherited_event_count, createdAt: row.created_at, updatedAt: row.updated_at, ...(row.workspace_ref === null ? {} : { workspaceRef: row.workspace_ref }), ...(row.upstream_header === null ? {} : { upstreamHeader: JSON.parse(row.upstream_header) }) });
const asFile = (row: Row): UpstreamFile => ({ id: row.id, ownerId: row.owner_id, metadata: JSON.parse(row.metadata), createdAt: row.created_at, deletedAt: row.deleted_at });

const schema = `
CREATE TABLE rufa_users (
 id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('employee','admin')),
 status TEXT NOT NULL CHECK(status IN ('active','disabled','deleted')) DEFAULT 'active',
 password_hash TEXT NOT NULL, created_at TEXT NOT NULL
) STRICT;
CREATE TABLE rufa_logins (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES rufa_users(id), device_id TEXT NOT NULL,
 device_label TEXT NOT NULL, access_hash TEXT NOT NULL UNIQUE, refresh_hash TEXT NOT NULL UNIQUE,
 access_expires_at TEXT NOT NULL, refresh_expires_at TEXT NOT NULL, revoked_at TEXT, created_at TEXT NOT NULL
) STRICT;
CREATE INDEX rufa_logins_user_idx ON rufa_logins(user_id);
CREATE TABLE rufa_spent_refresh (token_hash TEXT PRIMARY KEY, login_id TEXT NOT NULL REFERENCES rufa_logins(id), expires_at TEXT NOT NULL) STRICT;
CREATE TABLE rufa_sessions (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES rufa_users(id), title TEXT NOT NULL,
 workspace_ref TEXT, upstream_header TEXT CHECK(upstream_header IS NULL OR json_valid(upstream_header)),
 inherited_event_count INTEGER NOT NULL DEFAULT 0 CHECK(inherited_event_count>=0),
 next_seq INTEGER NOT NULL DEFAULT 0 CHECK(next_seq>=0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 lease_id TEXT, lease_login_id TEXT REFERENCES rufa_logins(id), lease_expires_at TEXT
) STRICT;
CREATE INDEX rufa_sessions_owner_idx ON rufa_sessions(owner_id,id);
CREATE TABLE rufa_session_events (
 session_id TEXT NOT NULL REFERENCES rufa_sessions(id), seq INTEGER NOT NULL CHECK(seq>=0),
 event TEXT NOT NULL CHECK(json_valid(event)), digest TEXT NOT NULL, PRIMARY KEY(session_id,seq)
) STRICT;
CREATE TABLE rufa_audit (
 id TEXT PRIMARY KEY, actor_id TEXT REFERENCES rufa_users(id), action TEXT NOT NULL,
 target_id TEXT, request_id TEXT, created_at TEXT NOT NULL
) STRICT;
CREATE TABLE rufa_usage (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES rufa_users(id), login_id TEXT NOT NULL REFERENCES rufa_logins(id),
 model TEXT NOT NULL, request_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('completed','failed','cancelled')),
 created_at TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER
) STRICT;
CREATE TABLE rufa_upstream_files (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES rufa_users(id), metadata TEXT NOT NULL CHECK(json_valid(metadata)),
 contents BLOB NOT NULL, created_at TEXT NOT NULL, deleted_at TEXT
) STRICT;
CREATE INDEX rufa_upstream_files_owner_idx ON rufa_upstream_files(owner_id,id);
PRAGMA user_version=1;
`;

/** Production embedded database. Keep the database on the server's local disk. */
export class SqliteStore implements Store {
  readonly db: DatabaseSync;
  readonly path: string;
  private closed = false;
  constructor(path: string) {
    if (path === ':memory:' || path.startsWith('\\\\')) throw new Error('SQLite requires a local persistent file path');
    this.path = resolve(path); mkdirSync(dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path, { enableForeignKeyConstraints: true });
    try {
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
      this.migrate();
    } catch (error) { this.db.close(); throw error; }
  }
  static open(path: string) { return new SqliteStore(path); }
  private row(sql: string, ...args: SQLInputValue[]): Row | undefined { return this.db.prepare(sql).get(...args); }
  private rows(sql: string, ...args: SQLInputValue[]): Row[] { return this.db.prepare(sql).all(...args); }
  private run(sql: string, ...args: SQLInputValue[]) { return this.db.prepare(sql).run(...args); }
  private tx<T>(work: () => T, mode: 'write' | 'read' = 'write'): T {
    this.db.exec(mode === 'read' ? 'BEGIN' : 'BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  migrate(): void {
    this.tx(() => {
      const version = Number(this.row('PRAGMA user_version')!.user_version);
      if (version > 4) throw new Error('Database schema is newer than this server');
      if (version === 0) this.db.exec(schema);
      if (version < 2) this.db.exec("ALTER TABLE rufa_users ADD COLUMN job_title TEXT NOT NULL DEFAULT '' CHECK(length(job_title)<=100); PRAGMA user_version=2;");
      if (version < 3) {
        this.db.exec('ALTER TABLE rufa_users ADD COLUMN deleted_at TEXT; ALTER TABLE rufa_users ADD COLUMN purge_after TEXT; ALTER TABLE rufa_users ADD COLUMN purged_at TEXT;');
        const time = utc();
        this.run("UPDATE rufa_users SET deleted_at=?,purge_after=? WHERE status='deleted'", time, purgeDeadline(time));
        this.db.exec('PRAGMA user_version=3;');
      }
      if (version < 4) this.db.exec(`
        CREATE TABLE IF NOT EXISTS rufa_preferences (user_id TEXT PRIMARY KEY REFERENCES rufa_users(id), snapshot TEXT NOT NULL CHECK(json_valid(snapshot))) STRICT;
        CREATE TABLE IF NOT EXISTS rufa_preference_mutations (
          user_id TEXT NOT NULL REFERENCES rufa_users(id), mutation_id TEXT NOT NULL, revision INTEGER NOT NULL,
          receipt TEXT NOT NULL CHECK(json_valid(receipt)), PRIMARY KEY(user_id,mutation_id), UNIQUE(user_id,revision)
        ) STRICT;
        PRAGMA user_version=4;
      `);
      // Additive read indexes; no event rewrite or schema-version downgrade barrier.
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS rufa_sessions_updated_idx ON rufa_sessions(updated_at DESC,id DESC);
        CREATE INDEX IF NOT EXISTS rufa_sessions_owner_updated_idx ON rufa_sessions(owner_id,updated_at DESC,id DESC);
        CREATE INDEX IF NOT EXISTS rufa_usage_created_user_idx ON rufa_usage(created_at,user_id);
      `);
    });
  }
  async ping(): Promise<void> { this.db.prepare('SELECT 1').get(); }
  private preferenceActor(access: PreferenceAccess) {
    const time = access.now();
    const user = this.row('SELECT * FROM rufa_users WHERE id=?', access.userId);
    const login = this.row('SELECT * FROM rufa_logins WHERE id=?', access.loginId);
    if (!user || user.status !== 'active' || !login || login.user_id !== access.userId || login.revoked_at || login.access_hash !== access.accessHash || login.access_expires_at <= time) throw unauthorized();
    return time;
  }
  private preferenceSnapshot(userId: string): PreferenceSnapshot {
    const row = this.row('SELECT snapshot FROM rufa_preferences WHERE user_id=?', userId);
    return row ? JSON.parse(row.snapshot) : emptyPreferences();
  }
  async getPreferences(access: PreferenceAccess) {
    return this.tx(() => { this.preferenceActor(access); return this.preferenceSnapshot(access.userId); });
  }
  async getPreferenceHistory(access: PreferenceAccess, query: PreferenceHistoryQuery) {
    return this.tx(() => {
      this.preferenceActor(access);
      const history = this.rows('SELECT receipt FROM rufa_preference_mutations WHERE user_id=? AND revision<? ORDER BY revision DESC LIMIT ?', access.userId, query.beforeRevision ?? Number.MAX_SAFE_INTEGER, query.limit + 1).map(row => (JSON.parse(row.receipt) as PreferenceRecord).history);
      return preferenceHistoryPage(history, query.limit);
    });
  }
  async mutatePreferences(access: PreferenceAccess, mutation: PreferenceMutation) {
    return this.tx(() => {
      const time = this.preferenceActor(access), snapshot = this.preferenceSnapshot(access.userId);
      const saved = this.row('SELECT receipt FROM rufa_preference_mutations WHERE user_id=? AND mutation_id=?', access.userId, mutation.mutationId);
      if (saved) {
        const receipt: PreferenceRecord = JSON.parse(saved.receipt);
        const history = this.rows('SELECT receipt FROM rufa_preference_mutations WHERE user_id=? AND revision<=? ORDER BY revision', access.userId, receipt.history.revision).map(row => (JSON.parse(row.receipt) as PreferenceRecord).history);
        return replayPreference(receipt, mutation, snapshot, history);
      }
      if (mutation.operation === 'put' && mutation.entry.source) {
        const session = this.row('SELECT owner_id FROM rufa_sessions WHERE id=?', mutation.entry.source.sessionId);
        if (!session || session.owner_id !== access.userId) throw notFound();
      }
      const receipt = applyPreference(snapshot, mutation, time);
      this.run('INSERT INTO rufa_preferences(user_id,snapshot) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET snapshot=excluded.snapshot', access.userId, JSON.stringify(receipt.result.snapshot));
      this.run('INSERT INTO rufa_preference_mutations(user_id,mutation_id,revision,receipt) VALUES(?,?,?,?)', access.userId, mutation.mutationId, receipt.history.revision, JSON.stringify(preferenceRecord(receipt)));
      this.insertAudit({ id: randomUUID(), actorId: access.userId, action: `preferences.${mutation.operation}`, targetId: receipt.history.id, requestId: access.requestId, createdAt: time });
      return receipt.result;
    });
  }
  async backupTo(destination: string): Promise<void> {
    const target = resolve(destination);
    if (target === this.path || destination.startsWith('\\\\') || existsSync(target) || ['-wal', '-shm', '-journal'].some(suffix => target === this.path + suffix)) throw new Error('Backup requires a new, different local file');
    mkdirSync(dirname(target), { recursive: true });
    // SQLite online backup includes committed WAL content and creates a consistent snapshot.
    await backup(this.db, target);
  }
  async findUser(username: string) { const row = this.row('SELECT * FROM rufa_users WHERE username=?', username); return row && asUser(row); }
  async listUsers() { return this.rows('SELECT * FROM rufa_users ORDER BY created_at,id').map(asUser); }
  async createUser(input: { username: string; displayName: string; jobTitle?: string; role: Role; passwordHash: string }, bootstrap = false) {
    return this.tx(() => {
      if (bootstrap && this.row('SELECT 1 FROM rufa_users LIMIT 1')) throw new AppError(409, 'ALREADY_INITIALIZED', '系统已初始化');
      if (this.row('SELECT 1 FROM rufa_users WHERE username=?', input.username)) throw new AppError(409, 'USERNAME_EXISTS', '账号已存在');
      const id = randomUUID();
      this.run('INSERT INTO rufa_users(id,username,display_name,job_title,role,password_hash,created_at) VALUES(?,?,?,?,?,?,?)', id, input.username, input.displayName, input.jobTitle ?? '', input.role, input.passwordHash, utc());
      return asUser(this.row('SELECT * FROM rufa_users WHERE id=?', id)!);
    });
  }
  async updateUser(id: string, patch: { displayName?: string; jobTitle?: string; role?: Role; status?: 'active' | 'disabled' | 'deleted' }) {
    return this.tx(() => {
      const row = this.row('SELECT * FROM rufa_users WHERE id=?', id); if (!row || row.status === 'deleted') throw notFound();
      const role = patch.role ?? row.role; const status = patch.status ?? row.status;
      if (row.role === 'admin' && row.status === 'active' && (role !== 'admin' || status !== 'active') && Number(this.row("SELECT count(*) AS n FROM rufa_users WHERE role='admin' AND status='active'")!.n) <= 1) throw new AppError(409, 'LAST_ADMIN', '必须保留至少一个启用的管理账号');
      this.run('UPDATE rufa_users SET display_name=?,job_title=?,role=?,status=? WHERE id=?', patch.displayName ?? row.display_name, patch.jobTitle ?? row.job_title, role, status, id);
      if (status === 'deleted') { const time = utc(); this.run('UPDATE rufa_users SET deleted_at=?,purge_after=? WHERE id=?', time, purgeDeadline(time), id); }
      if (status !== 'active' || role !== row.role) this.run('UPDATE rufa_logins SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL', utc(), id);
      return asUser(this.row('SELECT * FROM rufa_users WHERE id=?', id)!);
    });
  }
  async resetPassword(id: string, passwordHash: string) {
    this.tx(() => {
      if (!this.run("UPDATE rufa_users SET password_hash=? WHERE id=? AND status<>'deleted'", passwordHash, id).changes) throw notFound();
      this.run('UPDATE rufa_logins SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL', utc(), id);
    });
  }
  async changePassword(change: PasswordChange) {
    this.tx(() => {
      const user = this.row('SELECT * FROM rufa_users WHERE id=?', change.userId);
      const login = this.row('SELECT * FROM rufa_logins WHERE id=?', change.loginId);
      if (!user || user.status !== 'active' || !login || login.user_id !== change.userId || login.revoked_at || login.access_hash !== change.accessHash || login.access_expires_at <= change.now) throw unauthorized();
      if (user.password_hash !== change.expectedPasswordHash) throw new AppError(400, 'INVALID_CURRENT_PASSWORD', '原密码已变化，请重新输入');
      this.run('UPDATE rufa_users SET password_hash=? WHERE id=?', change.passwordHash, change.userId);
      this.run('UPDATE rufa_logins SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL', change.now, change.userId);
      const entry = change.audit;
      this.run('INSERT INTO rufa_audit(id,actor_id,action,target_id,request_id,created_at) VALUES(?,?,?,?,?,?)', entry.id, entry.actorId, entry.action, entry.targetId ?? null, entry.requestId ?? null, entry.createdAt);
    });
  }
  async updateProfile(change: ProfileChange): Promise<User> {
    return this.tx(() => {
      const user = this.row('SELECT * FROM rufa_users WHERE id=?', change.userId);
      const login = this.row('SELECT * FROM rufa_logins WHERE id=?', change.loginId);
      if (!user || user.status !== 'active' || !login || login.user_id !== change.userId || login.revoked_at || login.access_hash !== change.accessHash || login.access_expires_at <= change.now) throw unauthorized();
      this.run('UPDATE rufa_users SET display_name=?,job_title=? WHERE id=?', change.displayName, change.jobTitle, change.userId);
      const entry = change.audit;
      this.run('INSERT INTO rufa_audit(id,actor_id,action,target_id,request_id,created_at) VALUES(?,?,?,?,?,?)', entry.id, entry.actorId, entry.action, entry.targetId ?? null, entry.requestId ?? null, entry.createdAt);
      return asUser(this.row('SELECT * FROM rufa_users WHERE id=?', change.userId)!);
    });
  }
  private accountActor(change: AccountMutation) {
    const user = this.row('SELECT * FROM rufa_users WHERE id=?', change.userId);
    const login = this.row('SELECT * FROM rufa_logins WHERE id=?', change.loginId);
    if (!user || user.status !== 'active' || !login || login.user_id !== change.userId || login.revoked_at || login.access_hash !== change.accessHash || login.access_expires_at <= change.now) throw unauthorized();
    if (user.role !== 'admin') throw new AppError(403, 'FORBIDDEN', '需要管理权限');
  }
  async deleteUser(change: AccountMutation): Promise<User> {
    return this.tx(() => {
      this.accountActor(change);
      if (change.targetId === change.userId) throw new AppError(400, 'SELF_DELETE_NOT_ALLOWED', '不能删除当前登录的管理账号');
      const row = this.row('SELECT * FROM rufa_users WHERE id=?', change.targetId); if (!row) throw notFound();
      if (row.status === 'deleted') return asUser(row);
      if (row.role === 'admin' && row.status === 'active' && Number(this.row("SELECT count(*) AS n FROM rufa_users WHERE role='admin' AND status='active'")!.n) <= 1) throw new AppError(409, 'LAST_ADMIN', '必须保留至少一个启用的管理账号');
      this.run("UPDATE rufa_users SET status='deleted',deleted_at=?,purge_after=?,purged_at=NULL WHERE id=?", change.now, purgeDeadline(change.now), change.targetId);
      this.run('UPDATE rufa_logins SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL', change.now, change.targetId);
      this.insertAudit(change.audit);
      return asUser(this.row('SELECT * FROM rufa_users WHERE id=?', change.targetId)!);
    });
  }
  async restoreUser(change: AccountMutation, clock?: () => string): Promise<User> {
    return this.tx(() => {
      change = { ...change, now: clock?.() ?? change.now };
      this.accountActor(change);
      const row = this.row('SELECT * FROM rufa_users WHERE id=?', change.targetId); if (!row) throw notFound();
      if (row.purged_at || (row.status === 'deleted' && (!row.purge_after || row.purge_after <= change.now))) throw new AppError(409, 'RESTORE_EXPIRED', '账号恢复期限已过，聊天档案仍保留');
      if (row.status !== 'deleted') throw new AppError(409, 'USER_NOT_DELETED', '账号不在回收站中');
      this.run("UPDATE rufa_users SET status='active',deleted_at=NULL,purge_after=NULL WHERE id=?", change.targetId);
      this.insertAudit(change.audit);
      return asUser(this.row('SELECT * FROM rufa_users WHERE id=?', change.targetId)!);
    });
  }
  async purgeExpiredUsers(now: string): Promise<number> {
    return this.tx(() => {
      const expired = this.rows("SELECT id FROM rufa_users WHERE status='deleted' AND purged_at IS NULL AND purge_after<=? ORDER BY id", now);
      for (const { id } of expired) {
        this.run('DELETE FROM rufa_preference_mutations WHERE user_id=?', id);
        this.run('DELETE FROM rufa_preferences WHERE user_id=?', id);
        this.run('DELETE FROM rufa_spent_refresh WHERE login_id IN (SELECT id FROM rufa_logins WHERE user_id=?)', id);
        this.run('UPDATE rufa_sessions SET lease_id=NULL,lease_login_id=NULL,lease_expires_at=NULL WHERE lease_login_id IN (SELECT id FROM rufa_logins WHERE user_id=?)', id);
        this.run('DELETE FROM rufa_logins WHERE user_id=? AND NOT EXISTS (SELECT 1 FROM rufa_usage WHERE login_id=rufa_logins.id)', id);
        // Usage keeps a login FK. Retain only its identity/timestamps, with no usable credentials or device label.
        this.run("UPDATE rufa_logins SET access_hash='purged-access:'||id,refresh_hash='purged-refresh:'||id,device_id='00000000-0000-0000-0000-000000000000',device_label='',access_expires_at=?,refresh_expires_at=?,revoked_at=COALESCE(revoked_at,?) WHERE user_id=?", now, now, now, id);
        this.run("UPDATE rufa_users SET password_hash='',display_name=?,job_title='',role='employee',purged_at=? WHERE id=?", ARCHIVED_DISPLAY_NAME, now, id);
        this.insertAudit({ id: randomUUID(), actorId: null, action: 'system.user.purge', targetId: id, createdAt: now });
      }
      return expired.length;
    });
  }
  async createLogin(value: Login, expectedPasswordHash: string): Promise<AuthContext> {
    return this.tx(() => {
      const row = this.row('SELECT * FROM rufa_users WHERE id=?', value.userId);
      if (!row || row.status !== 'active' || row.password_hash !== expectedPasswordHash) throw unauthorized();
      this.run('INSERT INTO rufa_logins(id,user_id,device_id,device_label,access_hash,refresh_hash,access_expires_at,refresh_expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)', value.id, value.userId, value.deviceId, value.deviceLabel, value.accessHash, value.refreshHash, value.accessExpiresAt, value.refreshExpiresAt, value.createdAt);
      return { user: asUser(row), login: value };
    });
  }
  async resolveAccess(hash: string, now: string): Promise<AuthContext | undefined> {
    const login = this.row("SELECT l.* FROM rufa_logins l JOIN rufa_users u ON u.id=l.user_id WHERE l.access_hash=? AND l.revoked_at IS NULL AND l.access_expires_at>? AND u.status='active'", hash, now);
    return login ? { login: asLogin(login), user: asUser(this.row('SELECT * FROM rufa_users WHERE id=?', login.user_id)!) } : undefined;
  }
  async resolveLogin(id: string, now: string): Promise<AuthContext | undefined> {
    const login = this.row("SELECT l.* FROM rufa_logins l JOIN rufa_users u ON u.id=l.user_id WHERE l.id=? AND l.revoked_at IS NULL AND l.refresh_expires_at>? AND u.status='active'", id, now);
    return login ? { login: asLogin(login), user: asUser(this.row('SELECT * FROM rufa_users WHERE id=?', login.user_id)!) } : undefined;
  }
  async rotateRefresh(hash: string, rotation: TokenRotation, now: string): Promise<AuthContext | undefined> {
    return this.tx(() => {
      const login = this.row('SELECT * FROM rufa_logins WHERE refresh_hash=?', hash);
      if (!login) { this.run('UPDATE rufa_logins SET revoked_at=? WHERE id IN (SELECT login_id FROM rufa_spent_refresh WHERE token_hash=?)', now, hash); return undefined; }
      const user = this.row('SELECT * FROM rufa_users WHERE id=?', login.user_id);
      if (!user || user.status !== 'active' || login.revoked_at || login.refresh_expires_at <= now) return undefined;
      this.run('INSERT INTO rufa_spent_refresh(token_hash,login_id,expires_at) VALUES(?,?,?)', hash, login.id, login.refresh_expires_at);
      this.run('UPDATE rufa_logins SET access_hash=?,refresh_hash=?,access_expires_at=?,refresh_expires_at=? WHERE id=?', rotation.accessHash, rotation.refreshHash, rotation.accessExpiresAt, rotation.refreshExpiresAt, login.id);
      return { user: asUser(user), login: asLogin(this.row('SELECT * FROM rufa_logins WHERE id=?', login.id)!) };
    });
  }
  async revokeLogin(id: string) { this.run('UPDATE rufa_logins SET revoked_at=? WHERE id=?', utc(), id); }
  async createSession(ownerId: string, input: NewSession): Promise<SessionSummary> {
    return this.tx(() => {
      const id = input.id ?? randomUUID(); const now = utc();
      this.run('INSERT INTO rufa_sessions(id,owner_id,title,workspace_ref,upstream_header,inherited_event_count,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING', id, ownerId, input.title ?? '新会话', input.workspaceRef ?? null, input.upstreamHeader === undefined ? null : JSON.stringify(input.upstreamHeader), input.inheritedEventCount ?? 0, now, now);
      const row = this.row('SELECT * FROM rufa_sessions WHERE id=?', id)!;
      if (row.owner_id !== ownerId) throw new AppError(409, 'SESSION_ID_CONFLICT', '会话标识已被使用');
      const actual = asSession(row);
      if ((input.upstreamHeader !== undefined && eventDigest(input.upstreamHeader) !== eventDigest(actual.upstreamHeader)) || (input.inheritedEventCount !== undefined && input.inheritedEventCount !== actual.inheritedEventCount)) throw new AppError(409, 'SESSION_HEADER_CONFLICT', '会话创建元数据不一致');
      return actual;
    });
  }
  async listSessions(ownerId: string, limit: number, cursor?: string) { return this.rows('SELECT * FROM rufa_sessions WHERE owner_id=? AND (? IS NULL OR id>?) ORDER BY id LIMIT ?', ownerId, cursor ?? null, cursor ?? null, limit).map(asSession); }
  async queryAdminSessions(query: AdminSessionQuery) {
    return this.tx(() => {
      const count = adminSessionSql(query, 'sqlite', false), page = adminSessionSql(query, 'sqlite', true);
      const total = Number(this.row(count.sql, ...count.values)!.total);
      return adminSessionPage(this.rows(page.sql, ...page.values).map(asSession), total, query);
    }, 'read');
  }
  async getAdminOverview(range: AdminRange, now: string) {
    return this.tx(() => {
      const queries = adminOverviewSql(range, now, 'sqlite');
      const { accounts, sessions, usage, users } = queries;
      return adminOverviewResult(this.row(accounts.sql, ...accounts.values)!, this.row(sessions.sql, ...sessions.values)!, this.rows(usage.sql, ...usage.values), this.rows(users.sql));
    }, 'read');
  }
  async getSession(id: string) { const row = this.row('SELECT * FROM rufa_sessions WHERE id=?', id); return row && asSession(row); }
  async readEvents(id: string, afterSeq: number, limit: number) { return this.rows('SELECT seq,event FROM rufa_session_events WHERE session_id=? AND seq>? ORDER BY seq LIMIT ?', id, afterSeq, limit).map(row => ({ seq: row.seq, event: JSON.parse(row.event) })); }
  async readEventPage(id: string, afterSeq: number, limit: number) {
    return this.tx(() => {
      const row = this.row('SELECT next_seq FROM rufa_sessions WHERE id=?', id); if (!row) throw notFound();
      const events = this.rows('SELECT seq,event FROM rufa_session_events WHERE session_id=? AND seq>? AND seq<? ORDER BY seq LIMIT ?', id, afterSeq, row.next_seq, limit).map(item => ({ seq: item.seq, event: JSON.parse(item.event) }));
      return { events, nextSeq: row.next_seq as number };
    }, 'read');
  }
  private sessionForWrite(id: string, access: SessionAccess) {
    const user = this.row('SELECT * FROM rufa_users WHERE id=?', access.userId);
    const login = this.row('SELECT * FROM rufa_logins WHERE id=?', access.loginId);
    const row = this.row('SELECT * FROM rufa_sessions WHERE id=?', id);
    const now = access.now();
    if (!user || user.status !== 'active' || !login || login.user_id !== access.userId || login.revoked_at || login.access_hash !== access.accessHash || login.access_expires_at <= now) throw unauthorized();
    if (!row || row.owner_id !== access.userId) throw notFound();
    return { row, now };
  }
  async acquireLease(id: string, access: SessionAccess, ttlMs: number): Promise<Lease> {
    return this.tx(() => {
      const { row, now } = this.sessionForWrite(id, access), loginId = access.loginId;
      const expiresAt = new Date(Date.parse(now) + ttlMs).toISOString();
      if (row.lease_id && row.lease_expires_at > now && row.lease_login_id !== loginId) {
        const existing = this.row('SELECT revoked_at FROM rufa_logins WHERE id=?', row.lease_login_id);
        if (existing && !existing.revoked_at) throw new AppError(409, 'LEASE_CONFLICT', '会话正在其他设备上运行');
      }
      const leaseId = row.lease_login_id === loginId && row.lease_expires_at > now ? row.lease_id : randomUUID();
      this.run('UPDATE rufa_sessions SET lease_id=?,lease_login_id=?,lease_expires_at=? WHERE id=?', leaseId, loginId, expiresAt, id);
      return { leaseId, expiresAt, nextSeq: row.next_seq };
    });
  }
  async releaseLease(id: string, access: SessionAccess, leaseId: string) {
    this.tx(() => {
      this.sessionForWrite(id, access);
      if (!this.run('UPDATE rufa_sessions SET lease_id=NULL,lease_login_id=NULL,lease_expires_at=NULL WHERE id=? AND lease_login_id=? AND lease_id=?', id, access.loginId, leaseId).changes) throw new AppError(409, 'LEASE_LOST', '会话写入租约已失效');
    });
  }
  async appendEvents(id: string, access: SessionAccess, leaseId: string, expectedNextSeq: number, events: StoredEvent[]) {
    return this.tx(() => {
      const { row, now } = this.sessionForWrite(id, access), loginId = access.loginId;
      if (row.lease_login_id !== loginId || row.lease_id !== leaseId || !row.lease_expires_at || row.lease_expires_at <= now) throw new AppError(409, 'LEASE_LOST', '会话写入租约已失效');
      const next = row.next_seq as number;
      if (expectedNextSeq !== next) {
        if (expectedNextSeq < next && expectedNextSeq + events.length <= next) {
          const previous = this.rows('SELECT digest,event FROM rufa_session_events WHERE session_id=? AND seq>=? AND seq<? ORDER BY seq', id, expectedNextSeq, expectedNextSeq + events.length);
          if (previous.length === events.length && previous.every((value, index) => matchesSessionEvent(value.digest, () => JSON.parse(value.event), events[index].event))) return next;
        }
        throw new AppError(409, 'SEQUENCE_CONFLICT', '会话序号冲突，请重新读取服务端记录');
      }
      const statement = this.db.prepare('INSERT INTO rufa_session_events(session_id,seq,event,digest) VALUES(?,?,?,?)');
      for (const item of events) statement.run(id, item.seq, JSON.stringify(item.event), sessionEventDigest(item.event));
      const newNext = next + events.length;
      this.run('UPDATE rufa_sessions SET next_seq=?,updated_at=?,title=? WHERE id=?', newNext, now, latestSessionTitle(events) ?? row.title, id); return newNext;
    });
  }
  private insertAudit(entry: Audit) { this.run('INSERT INTO rufa_audit(id,actor_id,action,target_id,request_id,created_at) VALUES(?,?,?,?,?,?)', entry.id, entry.actorId, entry.action, entry.targetId ?? null, entry.requestId ?? null, entry.createdAt); }
  async audit(entry: Audit) { this.insertAudit(entry); }
  async recordUsage(entry: Usage) { this.run('INSERT INTO rufa_usage(id,user_id,login_id,model,request_id,status,created_at,input_tokens,output_tokens,total_tokens) VALUES(?,?,?,?,?,?,?,?,?,?)', entry.id, entry.userId, entry.loginId, entry.model, entry.requestId, entry.status, entry.createdAt, entry.inputTokens, entry.outputTokens, entry.totalTokens); }
  async saveFile(file: UpstreamFile, contents: Buffer) { this.run('INSERT INTO rufa_upstream_files(id,owner_id,metadata,contents,created_at) VALUES(?,?,?,?,?)', file.id, file.ownerId, JSON.stringify(file.metadata), contents, file.createdAt); }
  async getFile(id: string) { const row = this.row('SELECT id,owner_id,metadata,created_at,deleted_at FROM rufa_upstream_files WHERE id=?', id); return row && asFile(row); }
  async listFiles(ownerId: string, limit: number, afterId?: string) { return this.rows('SELECT id,owner_id,metadata,created_at,deleted_at FROM rufa_upstream_files WHERE owner_id=? AND deleted_at IS NULL AND (? IS NULL OR id>?) ORDER BY id LIMIT ?', ownerId, afterId ?? null, afterId ?? null, limit).map(asFile); }
  async markFileDeleted(id: string) { this.run('UPDATE rufa_upstream_files SET deleted_at=? WHERE id=?', utc(), id); }
  async close() { if (!this.closed) { this.db.close(); this.closed = true; } }
}
