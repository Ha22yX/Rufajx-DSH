import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import type { AccountMutation, PasswordChange, ProfileChange, SessionAccess, Store } from './store.js';
import { ARCHIVED_DISPLAY_NAME, purgeDeadline } from './account-lifecycle.js';
import { eventDigest } from './security.js';
import { matchesSessionEvent, sessionEventDigest } from './session-events.js';
import { latestSessionTitle } from './session-title.js';
import { adminOverviewResult, adminOverviewSql, adminSessionPage, adminSessionSql, type AdminRange, type AdminSessionQuery } from './admin-queries.js';
import { applyPreference, emptyPreferences, preferenceHistoryPage, preferenceRecord, replayPreference, type PreferenceAccess, type PreferenceHistoryQuery, type PreferenceMutation, type PreferenceSnapshot } from './preferences.js';
import { AppError, notFound, unauthorized, type Audit, type AuthContext, type Lease, type Login, type NewSession, type Role, type SessionSummary, type StoredEvent, type TokenRotation, type UpstreamFile, type Usage, type User } from './types.js';

const iso = (value: Date | string) => new Date(value).toISOString();
function user(row: Record<string, any>): User {
  return { id: row.id, username: row.username, displayName: row.display_name, jobTitle: row.job_title, role: row.role, status: row.status, passwordHash: row.password_hash, createdAt: iso(row.created_at), deletedAt: row.deleted_at ? iso(row.deleted_at) : null, purgeAfter: row.purge_after ? iso(row.purge_after) : null, purgedAt: row.purged_at ? iso(row.purged_at) : null };
}
function login(row: Record<string, any>): Login {
  return { id: row.id, userId: row.user_id, deviceId: row.device_id, deviceLabel: row.device_label, accessHash: row.access_hash, refreshHash: row.refresh_hash, accessExpiresAt: iso(row.access_expires_at), refreshExpiresAt: iso(row.refresh_expires_at), revokedAt: row.revoked_at ? iso(row.revoked_at) : null, createdAt: iso(row.created_at) };
}
function session(row: Record<string, any>): SessionSummary {
  return { id: row.id, ownerId: row.owner_id, title: row.title, nextSeq: Number(row.next_seq), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), inheritedEventCount: Number(row.inherited_event_count), ...(row.workspace_ref === null ? {} : { workspaceRef: row.workspace_ref }), ...(row.upstream_header === null ? {} : { upstreamHeader: row.upstream_header }) };
}

export class PostgresStore implements Store {
  constructor(public readonly pool: Pool) {}
  static connect(connectionString: string) { return new PostgresStore(new Pool({ connectionString, max: 10, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000 })); }
  private async tx<T>(work: (client: PoolClient) => Promise<T>, mode: 'write' | 'read' = 'write'): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query(mode === 'read' ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async migrate(): Promise<void> {
    const sql = await readFile(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8');
    const profileSql = await readFile(new URL('../migrations/002_user_profile.sql', import.meta.url), 'utf8');
    const trashSql = await readFile(new URL('../migrations/003_account_trash.sql', import.meta.url), 'utf8');
    const preferencesSql = await readFile(new URL('../migrations/004_preferences.sql', import.meta.url), 'utf8');
    await this.tx(async client => {
      await client.query('SELECT pg_advisory_xact_lock(738421001)');
      await client.query('CREATE TABLE IF NOT EXISTS rufa_schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
      if (Number((await client.query('SELECT COALESCE(MAX(version),0) AS version FROM rufa_schema_migrations')).rows[0].version) > 4) throw new Error('Database schema is newer than this server');
      if (!(await client.query('SELECT 1 FROM rufa_schema_migrations WHERE version=1')).rowCount) {
        await client.query(sql);
        await client.query('INSERT INTO rufa_schema_migrations(version) VALUES (1)');
      }
      if (!(await client.query('SELECT 1 FROM rufa_schema_migrations WHERE version=2')).rowCount) {
        await client.query(profileSql);
        await client.query('INSERT INTO rufa_schema_migrations(version) VALUES (2)');
      }
      if (!(await client.query('SELECT 1 FROM rufa_schema_migrations WHERE version=3')).rowCount) {
        await client.query(trashSql);
        await client.query('INSERT INTO rufa_schema_migrations(version) VALUES (3)');
      }
      if (!(await client.query('SELECT 1 FROM rufa_schema_migrations WHERE version=4')).rowCount) {
        await client.query(preferencesSql);
        await client.query('INSERT INTO rufa_schema_migrations(version) VALUES (4)');
      }
      await client.query('CREATE INDEX IF NOT EXISTS rufa_sessions_updated_idx ON rufa_sessions(updated_at DESC,id COLLATE "C" DESC)');
      await client.query('CREATE INDEX IF NOT EXISTS rufa_sessions_owner_updated_idx ON rufa_sessions(owner_id,updated_at DESC,id COLLATE "C" DESC)');
      await client.query('CREATE INDEX IF NOT EXISTS rufa_usage_created_user_idx ON rufa_usage(created_at,user_id)');
    });
  }
  async findUser(username: string) { const result = await this.pool.query('SELECT * FROM rufa_users WHERE username=$1', [username]); return result.rows[0] && user(result.rows[0]); }
  private async preferenceActor(client: PoolClient, access: PreferenceAccess) {
    // Same lock order as login rotation/revocation/account edits, also serializes per-user mutations.
    const u = (await client.query('SELECT * FROM rufa_users WHERE id=$1 FOR UPDATE', [access.userId])).rows[0];
    const l = (await client.query('SELECT * FROM rufa_logins WHERE id=$1 FOR UPDATE', [access.loginId])).rows[0];
    const time = access.now();
    if (!u || u.status !== 'active' || !l || l.user_id !== access.userId || l.revoked_at || l.access_hash !== access.accessHash || iso(l.access_expires_at) <= time) throw unauthorized();
    return time;
  }
  private async preferenceSnapshot(client: PoolClient, userId: string): Promise<PreferenceSnapshot> {
    return (await client.query('SELECT snapshot FROM rufa_preferences WHERE user_id=$1', [userId])).rows[0]?.snapshot ?? emptyPreferences();
  }
  async getPreferences(access: PreferenceAccess) {
    return this.tx(async client => { await this.preferenceActor(client, access); return this.preferenceSnapshot(client, access.userId); });
  }
  async getPreferenceHistory(access: PreferenceAccess, query: PreferenceHistoryQuery) {
    return this.tx(async client => {
      await this.preferenceActor(client, access);
      const rows = (await client.query('SELECT receipt FROM rufa_preference_mutations WHERE user_id=$1 AND revision<$2 ORDER BY revision DESC LIMIT $3', [access.userId, query.beforeRevision ?? Number.MAX_SAFE_INTEGER, query.limit + 1])).rows;
      return preferenceHistoryPage(rows.map(row => row.receipt.history), query.limit);
    });
  }
  async mutatePreferences(access: PreferenceAccess, mutation: PreferenceMutation) {
    return this.tx(async client => {
      const time = await this.preferenceActor(client, access), snapshot = await this.preferenceSnapshot(client, access.userId);
      const saved = (await client.query('SELECT receipt FROM rufa_preference_mutations WHERE user_id=$1 AND mutation_id=$2', [access.userId, mutation.mutationId])).rows[0];
      if (saved) {
        const history = (await client.query('SELECT receipt FROM rufa_preference_mutations WHERE user_id=$1 AND revision<=$2 ORDER BY revision', [access.userId, saved.receipt.history.revision])).rows.map(row => row.receipt.history);
        return replayPreference(saved.receipt, mutation, snapshot, history);
      }
      if (mutation.operation === 'put' && mutation.entry.source) {
        const session = (await client.query('SELECT owner_id FROM rufa_sessions WHERE id=$1', [mutation.entry.source.sessionId])).rows[0];
        if (!session || session.owner_id !== access.userId) throw notFound();
      }
      const receipt = applyPreference(snapshot, mutation, time);
      await client.query('INSERT INTO rufa_preferences(user_id,snapshot) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET snapshot=excluded.snapshot', [access.userId, JSON.stringify(receipt.result.snapshot)]);
      await client.query('INSERT INTO rufa_preference_mutations(user_id,mutation_id,revision,receipt) VALUES($1,$2,$3,$4)', [access.userId, mutation.mutationId, receipt.history.revision, JSON.stringify(preferenceRecord(receipt))]);
      await client.query('INSERT INTO rufa_audit(id,actor_id,action,target_id,request_id,created_at) VALUES($1,$2,$3,$4,$5,$6)', [randomUUID(), access.userId, `preferences.${mutation.operation}`, receipt.history.id, access.requestId ?? null, time]);
      return receipt.result;
    });
  }
  async listUsers() { return (await this.pool.query('SELECT * FROM rufa_users ORDER BY created_at,id')).rows.map(user); }
  async createUser(input: { username: string; displayName: string; jobTitle?: string; role: Role; passwordHash: string }, bootstrap = false) {
    try { return await this.tx(async client => {
      await client.query('SELECT pg_advisory_xact_lock(738421002)');
      if (bootstrap && (await client.query('SELECT 1 FROM rufa_users LIMIT 1')).rowCount) throw new AppError(409, 'ALREADY_INITIALIZED', '系统已初始化');
      return user((await client.query('INSERT INTO rufa_users(id,username,display_name,job_title,role,password_hash) VALUES($1,$2,$3,$4,$5,$6) RETURNING *', [randomUUID(), input.username, input.displayName, input.jobTitle ?? '', input.role, input.passwordHash])).rows[0]);
    }); } catch (error: any) { if (error?.code === '23505') throw new AppError(409, 'USERNAME_EXISTS', '账号已存在'); throw error; }
  }
  async updateUser(id: string, patch: { displayName?: string; jobTitle?: string; role?: Role; status?: 'active' | 'disabled' | 'deleted' }) {
    return this.tx(async client => {
      // Serialize administrator count changes across independent server instances.
      await client.query('SELECT pg_advisory_xact_lock(738421002)');
      const row = (await client.query('SELECT * FROM rufa_users WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!row || row.status === 'deleted') throw notFound();
      const role = patch.role ?? row.role;
      const status = patch.status ?? row.status;
      if (row.role === 'admin' && row.status === 'active' && (role !== 'admin' || status !== 'active')) {
        const count = Number((await client.query("SELECT count(*) AS n FROM rufa_users WHERE role='admin' AND status='active'")).rows[0].n);
        if (count <= 1) throw new AppError(409, 'LAST_ADMIN', '必须保留至少一个启用的管理账号');
      }
      const updated = (await client.query('UPDATE rufa_users SET display_name=$2,job_title=$3,role=$4,status=$5 WHERE id=$1 RETURNING *', [id, patch.displayName ?? row.display_name, patch.jobTitle ?? row.job_title, role, status])).rows[0];
      if (status === 'deleted') { const time = new Date().toISOString(); await client.query('UPDATE rufa_users SET deleted_at=$2,purge_after=$3 WHERE id=$1', [id, time, purgeDeadline(time)]); updated.deleted_at = time; updated.purge_after = purgeDeadline(time); }
      if (status !== 'active' || role !== row.role) await client.query('UPDATE rufa_logins SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [id]);
      return user(updated);
    });
  }
  async resetPassword(id: string, passwordHash: string) {
    await this.tx(async client => {
      const result = await client.query("UPDATE rufa_users SET password_hash=$2 WHERE id=$1 AND status <> 'deleted' RETURNING id", [id, passwordHash]);
      if (!result.rowCount) throw notFound();
      await client.query('UPDATE rufa_logins SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [id]);
    });
  }
  async changePassword(change: PasswordChange) {
    await this.tx(async client => {
      // Match createLogin/refresh/account updates: always lock user before login.
      const u = (await client.query('SELECT * FROM rufa_users WHERE id=$1 FOR UPDATE', [change.userId])).rows[0];
      const l = (await client.query('SELECT * FROM rufa_logins WHERE id=$1 FOR UPDATE', [change.loginId])).rows[0];
      if (!u || u.status !== 'active' || !l || l.user_id !== change.userId || l.revoked_at || l.access_hash !== change.accessHash || iso(l.access_expires_at) <= change.now) throw unauthorized();
      if (u.password_hash !== change.expectedPasswordHash) throw new AppError(400, 'INVALID_CURRENT_PASSWORD', '原密码已变化，请重新输入');
      await client.query('UPDATE rufa_users SET password_hash=$2 WHERE id=$1', [change.userId, change.passwordHash]);
      await client.query('UPDATE rufa_logins SET revoked_at=$2 WHERE user_id=$1 AND revoked_at IS NULL', [change.userId, change.now]);
      const entry = change.audit;
      await client.query('INSERT INTO rufa_audit(id,actor_id,action,target_id,request_id,created_at) VALUES($1,$2,$3,$4,$5,$6)', [entry.id, entry.actorId, entry.action, entry.targetId ?? null, entry.requestId ?? null, entry.createdAt]);
    });
  }
  async updateProfile(change: ProfileChange): Promise<User> {
    return this.tx(async client => {
      const u = (await client.query('SELECT * FROM rufa_users WHERE id=$1 FOR UPDATE', [change.userId])).rows[0];
      const l = (await client.query('SELECT * FROM rufa_logins WHERE id=$1 FOR UPDATE', [change.loginId])).rows[0];
      if (!u || u.status !== 'active' || !l || l.user_id !== change.userId || l.revoked_at || l.access_hash !== change.accessHash || iso(l.access_expires_at) <= change.now) throw unauthorized();
      const updated = (await client.query('UPDATE rufa_users SET display_name=$2,job_title=$3 WHERE id=$1 RETURNING *', [change.userId, change.displayName, change.jobTitle])).rows[0];
      const entry = change.audit;
      await client.query('INSERT INTO rufa_audit(id,actor_id,action,target_id,request_id,created_at) VALUES($1,$2,$3,$4,$5,$6)', [entry.id, entry.actorId, entry.action, entry.targetId ?? null, entry.requestId ?? null, entry.createdAt]);
      return user(updated);
    });
  }
  private async accountActor(client: PoolClient, change: AccountMutation) {
    const u = (await client.query('SELECT * FROM rufa_users WHERE id=$1 FOR UPDATE', [change.userId])).rows[0];
    const l = (await client.query('SELECT * FROM rufa_logins WHERE id=$1 FOR UPDATE', [change.loginId])).rows[0];
    if (!u || u.status !== 'active' || !l || l.user_id !== change.userId || l.revoked_at || l.access_hash !== change.accessHash || iso(l.access_expires_at) <= change.now) throw unauthorized();
    if (u.role !== 'admin') throw new AppError(403, 'FORBIDDEN', '需要管理权限');
    return l;
  }
  async deleteUser(change: AccountMutation): Promise<User> {
    return this.tx(async client => {
      await client.query('SELECT pg_advisory_xact_lock(738421002)');
      await this.accountActor(client, change);
      if (change.targetId === change.userId) throw new AppError(400, 'SELF_DELETE_NOT_ALLOWED', '不能删除当前登录的管理账号');
      const row = (await client.query('SELECT * FROM rufa_users WHERE id=$1 FOR UPDATE', [change.targetId])).rows[0]; if (!row) throw notFound();
      if (row.status === 'deleted') return user(row);
      if (row.role === 'admin' && row.status === 'active' && Number((await client.query("SELECT count(*) AS n FROM rufa_users WHERE role='admin' AND status='active'")).rows[0].n) <= 1) throw new AppError(409, 'LAST_ADMIN', '必须保留至少一个启用的管理账号');
      const updated = (await client.query("UPDATE rufa_users SET status='deleted',deleted_at=$2,purge_after=$3,purged_at=NULL WHERE id=$1 RETURNING *", [change.targetId, change.now, purgeDeadline(change.now)])).rows[0];
      await client.query('UPDATE rufa_logins SET revoked_at=$2 WHERE user_id=$1 AND revoked_at IS NULL', [change.targetId, change.now]);
      await this.insertAudit(client, change.audit);
      return user(updated);
    });
  }
  async restoreUser(change: AccountMutation, clock?: () => string): Promise<User> {
    return this.tx(async client => {
      await client.query('SELECT pg_advisory_xact_lock(738421002)');
      const actorLogin = await this.accountActor(client, change);
      const row = (await client.query('SELECT * FROM rufa_users WHERE id=$1 FOR UPDATE', [change.targetId])).rows[0]; if (!row) throw notFound();
      change = { ...change, now: clock?.() ?? change.now };
      if (iso(actorLogin.access_expires_at) <= change.now) throw unauthorized();
      if (row.purged_at || (row.status === 'deleted' && (!row.purge_after || iso(row.purge_after) <= change.now))) throw new AppError(409, 'RESTORE_EXPIRED', '账号恢复期限已过，聊天档案仍保留');
      if (row.status !== 'deleted') throw new AppError(409, 'USER_NOT_DELETED', '账号不在回收站中');
      const updated = (await client.query("UPDATE rufa_users SET status='active',deleted_at=NULL,purge_after=NULL WHERE id=$1 RETURNING *", [change.targetId])).rows[0];
      await this.insertAudit(client, change.audit);
      return user(updated);
    });
  }
  async purgeExpiredUsers(now: string): Promise<number> {
    return this.tx(async client => {
      const expired = (await client.query("SELECT id FROM rufa_users WHERE status='deleted' AND purged_at IS NULL AND purge_after<=$1 ORDER BY id FOR UPDATE", [now])).rows;
      for (const { id } of expired) {
        await client.query('DELETE FROM rufa_preference_mutations WHERE user_id=$1', [id]);
        await client.query('DELETE FROM rufa_preferences WHERE user_id=$1', [id]);
        await client.query('DELETE FROM rufa_spent_refresh WHERE login_id IN (SELECT id FROM rufa_logins WHERE user_id=$1)', [id]);
        await client.query('UPDATE rufa_sessions SET lease_id=NULL,lease_login_id=NULL,lease_expires_at=NULL WHERE lease_login_id IN (SELECT id FROM rufa_logins WHERE user_id=$1)', [id]);
        await client.query('DELETE FROM rufa_logins WHERE user_id=$1 AND NOT EXISTS (SELECT 1 FROM rufa_usage WHERE login_id=rufa_logins.id)', [id]);
        await client.query("UPDATE rufa_logins SET access_hash=concat('purged-access:',id),refresh_hash=concat('purged-refresh:',id),device_id='00000000-0000-0000-0000-000000000000',device_label='',access_expires_at=$2,refresh_expires_at=$2,revoked_at=COALESCE(revoked_at,$2) WHERE user_id=$1", [id, now]);
        await client.query("UPDATE rufa_users SET password_hash='',display_name=$2,job_title='',role='employee',purged_at=$3 WHERE id=$1", [id, ARCHIVED_DISPLAY_NAME, now]);
        await this.insertAudit(client, { id: randomUUID(), actorId: null, action: 'system.user.purge', targetId: id, createdAt: now });
      }
      return expired.length;
    });
  }
  async createLogin(value: Login, expectedPasswordHash: string): Promise<AuthContext> {
    return this.tx(async client => {
      const row = (await client.query('SELECT * FROM rufa_users WHERE id=$1 FOR UPDATE', [value.userId])).rows[0];
      if (!row || row.status !== 'active' || row.password_hash !== expectedPasswordHash) throw unauthorized();
      await client.query('INSERT INTO rufa_logins(id,user_id,device_id,device_label,access_hash,refresh_hash,access_expires_at,refresh_expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [value.id, value.userId, value.deviceId, value.deviceLabel, value.accessHash, value.refreshHash, value.accessExpiresAt, value.refreshExpiresAt, value.createdAt]);
      return { user: user(row), login: value };
    });
  }
  async resolveAccess(accessHash: string, now: string): Promise<AuthContext | undefined> {
    const row = (await this.pool.query("SELECT row_to_json(u) AS u,row_to_json(l) AS l FROM rufa_logins l JOIN rufa_users u ON u.id=l.user_id WHERE l.access_hash=$1 AND l.revoked_at IS NULL AND l.access_expires_at>$2 AND u.status='active'", [accessHash, now])).rows[0];
    return row ? { user: user(row.u), login: login(row.l) } : undefined;
  }
  async resolveLogin(loginId: string, now: string): Promise<AuthContext | undefined> {
    const row = (await this.pool.query("SELECT row_to_json(u) AS u,row_to_json(l) AS l FROM rufa_logins l JOIN rufa_users u ON u.id=l.user_id WHERE l.id=$1 AND l.revoked_at IS NULL AND l.refresh_expires_at>$2 AND u.status='active'", [loginId, now])).rows[0];
    return row ? { user: user(row.u), login: login(row.l) } : undefined;
  }
  async rotateRefresh(hash: string, rotation: TokenRotation, now: string): Promise<AuthContext | undefined> {
    return this.tx(async client => {
      // Global auth rotation lock avoids deadlocks with password/account updates and
      // ensures a concurrent replay revokes the token family that just rotated.
      await client.query('SELECT pg_advisory_xact_lock(738421003)');
      const lookup = (await client.query('SELECT user_id FROM rufa_logins WHERE refresh_hash=$1', [hash])).rows[0];
      if (!lookup) {
        await client.query('UPDATE rufa_logins SET revoked_at=$2 WHERE id IN (SELECT login_id FROM rufa_spent_refresh WHERE token_hash=$1)', [hash, now]);
        return undefined;
      }
      const u = (await client.query('SELECT * FROM rufa_users WHERE id=$1 FOR UPDATE', [lookup.user_id])).rows[0];
      const l = (await client.query('SELECT * FROM rufa_logins WHERE refresh_hash=$1 FOR UPDATE', [hash])).rows[0];
      if (!l || !u || u.status !== 'active' || l.revoked_at || iso(l.refresh_expires_at) <= now) return undefined;
      await client.query('INSERT INTO rufa_spent_refresh(token_hash,login_id,expires_at) VALUES($1,$2,$3)', [hash, l.id, l.refresh_expires_at]);
      const updated = (await client.query('UPDATE rufa_logins SET access_hash=$2,refresh_hash=$3,access_expires_at=$4,refresh_expires_at=$5 WHERE id=$1 RETURNING *', [l.id, rotation.accessHash, rotation.refreshHash, rotation.accessExpiresAt, rotation.refreshExpiresAt])).rows[0];
      return { user: user(u), login: login(updated) };
    });
  }
  async revokeLogin(id: string) { await this.pool.query('UPDATE rufa_logins SET revoked_at=now() WHERE id=$1', [id]); }
  async createSession(ownerId: string, input: NewSession): Promise<SessionSummary> {
    const id = input.id ?? randomUUID();
    return this.tx(async client => {
      await client.query('INSERT INTO rufa_sessions(id,owner_id,title,workspace_ref,upstream_header,inherited_event_count) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING', [id, ownerId, input.title ?? '新会话', input.workspaceRef ?? null, input.upstreamHeader === undefined ? null : JSON.stringify(input.upstreamHeader), input.inheritedEventCount ?? 0]);
      const row = (await client.query('SELECT * FROM rufa_sessions WHERE id=$1', [id])).rows[0];
      if (row.owner_id !== ownerId) throw new AppError(409, 'SESSION_ID_CONFLICT', '会话标识已被使用');
      const actual = session(row);
      if ((input.upstreamHeader !== undefined && eventDigest(input.upstreamHeader) !== eventDigest(actual.upstreamHeader)) || (input.inheritedEventCount !== undefined && input.inheritedEventCount !== actual.inheritedEventCount)) throw new AppError(409, 'SESSION_HEADER_CONFLICT', '会话创建元数据不一致');
      return actual;
    });
  }
  async listSessions(ownerId: string, limit: number, cursor?: string) {
    return (await this.pool.query('SELECT * FROM rufa_sessions WHERE owner_id=$1 AND ($2::text IS NULL OR id>$2) ORDER BY id LIMIT $3', [ownerId, cursor ?? null, limit])).rows.map(session);
  }
  async queryAdminSessions(query: AdminSessionQuery) {
    return this.tx(async client => {
      const count = adminSessionSql(query, 'postgres', false), page = adminSessionSql(query, 'postgres', true);
      const total = Number((await client.query(count.sql, count.values)).rows[0].total);
      const rows = (await client.query(page.sql, page.values)).rows;
      return adminSessionPage(rows.map(session), total, query, rows[query.limit - 1]?.cursor_time);
    }, 'read');
  }
  async getAdminOverview(range: AdminRange, now: string) {
    return this.tx(async client => {
      const { accounts, sessions, usage, users } = adminOverviewSql(range, now, 'postgres');
      return adminOverviewResult((await client.query(accounts.sql, accounts.values)).rows[0], (await client.query(sessions.sql, sessions.values)).rows[0], (await client.query(usage.sql, usage.values)).rows, (await client.query(users.sql)).rows);
    }, 'read');
  }
  async getSession(id: string) { const row = (await this.pool.query('SELECT * FROM rufa_sessions WHERE id=$1', [id])).rows[0]; return row ? session(row) : undefined; }
  async readEvents(id: string, afterSeq: number, limit: number) {
    return (await this.pool.query('SELECT seq,event FROM rufa_session_events WHERE session_id=$1 AND seq>$2 ORDER BY seq LIMIT $3', [id, afterSeq, limit])).rows.map(row => ({ seq: Number(row.seq), event: row.event }));
  }
  async readEventPage(id: string, afterSeq: number, limit: number) {
    return this.tx(async client => {
      const row = (await client.query('SELECT next_seq FROM rufa_sessions WHERE id=$1', [id])).rows[0]; if (!row) throw notFound();
      const nextSeq = Number(row.next_seq);
      const events = (await client.query('SELECT seq,event FROM rufa_session_events WHERE session_id=$1 AND seq>$2 AND seq<$3 ORDER BY seq LIMIT $4', [id, afterSeq, nextSeq, limit])).rows.map(item => ({ seq: Number(item.seq), event: item.event }));
      return { events, nextSeq };
    }, 'read');
  }
  private async sessionForWrite(client: PoolClient, id: string, access: SessionAccess) {
    // All account mutations lock user before login. Take the session lock last,
    // then sample time: time spent waiting for any lock must not extend a lease.
    const u = (await client.query('SELECT * FROM rufa_users WHERE id=$1 FOR UPDATE', [access.userId])).rows[0];
    const l = (await client.query('SELECT * FROM rufa_logins WHERE id=$1 FOR UPDATE', [access.loginId])).rows[0];
    const row = (await client.query('SELECT * FROM rufa_sessions WHERE id=$1 FOR UPDATE', [id])).rows[0];
    const now = access.now();
    if (!u || u.status !== 'active' || !l || l.user_id !== access.userId || l.revoked_at || l.access_hash !== access.accessHash || iso(l.access_expires_at) <= now) throw unauthorized();
    if (!row || row.owner_id !== access.userId) throw notFound();
    return { row, now };
  }
  async acquireLease(id: string, access: SessionAccess, ttlMs: number): Promise<Lease> {
    return this.tx(async client => {
      const { row, now } = await this.sessionForWrite(client, id, access), loginId = access.loginId;
      const expiresAt = new Date(Date.parse(now) + ttlMs).toISOString();
      if (row.lease_id && row.lease_expires_at && iso(row.lease_expires_at) > now && row.lease_login_id !== loginId) {
        const existing = (await client.query('SELECT revoked_at FROM rufa_logins WHERE id=$1', [row.lease_login_id])).rows[0];
        if (existing && !existing.revoked_at) throw new AppError(409, 'LEASE_CONFLICT', '会话正在其他设备上运行');
      }
      const leaseId = row.lease_login_id === loginId && row.lease_expires_at && iso(row.lease_expires_at) > now ? row.lease_id : randomUUID();
      await client.query('UPDATE rufa_sessions SET lease_id=$2,lease_login_id=$3,lease_expires_at=$4 WHERE id=$1', [id, leaseId, loginId, expiresAt]);
      return { leaseId, expiresAt, nextSeq: Number(row.next_seq) };
    });
  }
  async releaseLease(id: string, access: SessionAccess, leaseId: string) {
    await this.tx(async client => {
      await this.sessionForWrite(client, id, access);
      const result = await client.query('UPDATE rufa_sessions SET lease_id=NULL,lease_login_id=NULL,lease_expires_at=NULL WHERE id=$1 AND lease_login_id=$2 AND lease_id=$3', [id, access.loginId, leaseId]);
      if (!result.rowCount) throw new AppError(409, 'LEASE_LOST', '会话写入租约已失效');
    });
  }
  async appendEvents(id: string, access: SessionAccess, leaseId: string, expectedNextSeq: number, events: StoredEvent[]) {
    return this.tx(async client => {
      const { row, now } = await this.sessionForWrite(client, id, access), loginId = access.loginId;
      if (row.lease_login_id !== loginId || row.lease_id !== leaseId || !row.lease_expires_at || iso(row.lease_expires_at) <= now) throw new AppError(409, 'LEASE_LOST', '会话写入租约已失效');
      const next = Number(row.next_seq);
      if (expectedNextSeq !== next) {
        if (expectedNextSeq < next && expectedNextSeq + events.length <= next) {
          const previous = (await client.query('SELECT digest,event FROM rufa_session_events WHERE session_id=$1 AND seq >= $2 AND seq < $3 ORDER BY seq', [id, expectedNextSeq, expectedNextSeq + events.length])).rows;
          if (previous.length === events.length && previous.every((value, index) => matchesSessionEvent(value.digest, () => value.event, events[index].event))) return next;
        }
        throw new AppError(409, 'SEQUENCE_CONFLICT', '会话序号冲突，请重新读取服务端记录');
      }
      await client.query('INSERT INTO rufa_session_events(session_id,seq,event,digest) SELECT $1, x.seq, x.event, x.digest FROM jsonb_to_recordset($2::jsonb) AS x(seq bigint,event jsonb,digest text)', [id, JSON.stringify(events.map(item => ({ ...item, digest: sessionEventDigest(item.event) })))]);
      const newNext = next + events.length;
      await client.query('UPDATE rufa_sessions SET next_seq=$2,updated_at=$3,title=$4 WHERE id=$1', [id, newNext, now, latestSessionTitle(events) ?? row.title]);
      return newNext;
    });
  }
  private async insertAudit(client: Pick<PoolClient, 'query'>, entry: Audit) {
    await client.query('INSERT INTO rufa_audit(id,actor_id,action,target_id,request_id,created_at) VALUES($1,$2,$3,$4,$5,$6)', [entry.id, entry.actorId, entry.action, entry.targetId ?? null, entry.requestId ?? null, entry.createdAt]);
  }
  async audit(entry: Audit) { await this.insertAudit(this.pool, entry); }
  async recordUsage(entry: Usage) {
    await this.pool.query('INSERT INTO rufa_usage(id,user_id,login_id,model,request_id,status,created_at,input_tokens,output_tokens,total_tokens) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [entry.id, entry.userId, entry.loginId, entry.model, entry.requestId, entry.status, entry.createdAt, entry.inputTokens, entry.outputTokens, entry.totalTokens]);
  }
  async saveFile(file: UpstreamFile, contents: Buffer) {
    await this.pool.query('INSERT INTO rufa_upstream_files(id,owner_id,metadata,contents,created_at) VALUES($1,$2,$3,$4,$5)', [file.id, file.ownerId, JSON.stringify(file.metadata), contents, file.createdAt]);
  }
  async getFile(id: string): Promise<UpstreamFile | undefined> {
    const row = (await this.pool.query('SELECT id,owner_id,metadata,created_at,deleted_at FROM rufa_upstream_files WHERE id=$1', [id])).rows[0];
    return row ? { id: row.id, ownerId: row.owner_id, metadata: row.metadata, createdAt: iso(row.created_at), deletedAt: row.deleted_at ? iso(row.deleted_at) : null } : undefined;
  }
  async listFiles(ownerId: string, limit: number, afterId?: string): Promise<UpstreamFile[]> {
    return (await this.pool.query('SELECT id,owner_id,metadata,created_at,deleted_at FROM rufa_upstream_files WHERE owner_id=$1 AND deleted_at IS NULL AND ($2::text IS NULL OR id>$2) ORDER BY id LIMIT $3', [ownerId, afterId ?? null, limit])).rows.map(row => ({ id: row.id, ownerId: row.owner_id, metadata: row.metadata, createdAt: iso(row.created_at), deletedAt: null }));
  }
  async markFileDeleted(id: string) { await this.pool.query('UPDATE rufa_upstream_files SET deleted_at=now() WHERE id=$1', [id]); }
  async close() { await this.pool.end(); }
}
