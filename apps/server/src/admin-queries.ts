import { createHash } from 'node:crypto';
import { invalid, type SessionSummary } from './types.js';

export interface AdminRange { from?: string; to?: string }
export interface AdminSessionQuery extends AdminRange {
  ownerId?: string; q?: string; limit: number;
  cursor?: { updatedAt: string; id: string };
}
export interface AdminSessionPage { sessions: SessionSummary[]; total: number; nextCursor?: string }
export interface AdminUsage {
  requests: number; completed: number; failed: number; cancelled: number;
  inputTokens: number; outputTokens: number; totalTokens: number; missingUsageRequests: number;
}
export interface AdminOverview {
  accounts: { total: number; active: number; disabled: number; recycled: number; archived: number };
  sessions: { total: number; updatedInRange: number };
  usage: AdminUsage;
  users: { userId: string; sessions: number; requests: number; inputTokens: number; outputTokens: number; totalTokens: number; missingUsageRequests: number }[];
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function date(value: unknown, field: string, cursor = false): string {
  const pattern = cursor
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?Z$/
    : /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2}))$/;
  const match = typeof value === 'string' ? pattern.exec(value) : null;
  if (!match) throw invalid(`${field} 必须为含时区的ISO时间`);
  const [, y, m, d, h, min, s, oh, om] = match;
  const year = Number(y), month = Number(m), day = Number(d);
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1] || Number(h) > 23 || Number(min) > 59 || Number(s) > 59 || Number(oh ?? 0) > 23 || Number(om ?? 0) > 59) throw invalid(`${field} 时间无效`);
  const time = Date.parse(value as string);
  if (!Number.isFinite(time)) throw invalid(`${field} 时间无效`);
  const iso = new Date(time).toISOString();
  if (iso.length !== 24 || iso.startsWith('0000')) throw invalid(`${field} 时间超出范围`);
  // PostgreSQL can store microseconds. Preserve its exact keyset boundary.
  return cursor ? value as string : iso;
}
function range(query: Record<string, unknown>): AdminRange {
  const from = query.from === undefined ? undefined : date(query.from, 'from');
  const to = query.to === undefined ? undefined : date(query.to, 'to');
  if (from !== undefined && to !== undefined && from >= to) throw invalid('开始时间必须早于结束时间');
  return { ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) };
}
export function parseAdminRange(value: unknown): AdminRange {
  const query = object(value);
  if (Object.keys(query).some(key => !['from', 'to'].includes(key))) throw invalid();
  return range(query);
}
const idPattern = /^[a-zA-Z0-9_.-]{1,128}$/;
const filterKey = (query: AdminSessionQuery) => createHash('sha256').update(JSON.stringify([query.ownerId ?? null, query.q ?? null, query.from ?? null, query.to ?? null])).digest('hex');
export function parseAdminSessionQuery(value: unknown): AdminSessionQuery {
  const query = object(value);
  if (Object.keys(query).some(key => !['ownerId', 'q', 'from', 'to', 'limit', 'cursor'].includes(key))) throw invalid();
  const result: AdminSessionQuery = { ...range(query), limit: 50 };
  if (query.ownerId !== undefined) {
    if (typeof query.ownerId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(query.ownerId)) throw invalid('账号ID无效');
    result.ownerId = query.ownerId.toLowerCase();
  }
  if (query.q !== undefined) {
    if (typeof query.q !== 'string' || query.q.length > 200 || /\p{Surrogate}|\u0000/u.test(query.q)) throw invalid('检索内容须为至多200个字符的文本');
    if (query.q.trim()) result.q = query.q.trim();
  }
  if (query.limit !== undefined) {
    if (typeof query.limit !== 'string' || !/^\d{1,4}$/.test(query.limit) || Number(query.limit) < 1 || Number(query.limit) > 1000) throw invalid('分页数量须为1至1000');
    result.limit = Number(query.limit);
  }
  if (query.cursor !== undefined) {
    if (typeof query.cursor !== 'string' || query.cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw invalid('分页位置无效');
    let decoded: Record<string, unknown>;
    try {
      const bytes = Buffer.from(query.cursor, 'base64url');
      if (bytes.toString('base64url') !== query.cursor) throw invalid();
      decoded = object(JSON.parse(bytes.toString('utf8')));
    } catch { throw invalid('分页位置无效'); }
    if (Object.keys(decoded).sort().join(',') !== 'filter,id,updatedAt,v' || decoded.v !== 1 || decoded.filter !== filterKey(result) || typeof decoded.id !== 'string' || !idPattern.test(decoded.id)) throw invalid('分页位置与当前筛选不匹配');
    result.cursor = { updatedAt: date(decoded.updatedAt, 'cursor', true), id: decoded.id };
  }
  return result;
}
export function adminSessionPage(rows: SessionSummary[], total: number, query: AdminSessionQuery, lastTime?: string): AdminSessionPage {
  const sessions = rows.slice(0, query.limit), last = sessions.at(-1);
  return { sessions, total, ...(rows.length > query.limit && last ? { nextCursor: Buffer.from(JSON.stringify({ v: 1, filter: filterKey(query), updatedAt: lastTime ?? last.updatedAt, id: last.id })).toString('base64url') } : {}) };
}

type Dialect = 'sqlite' | 'postgres';
function parameters(dialect: Dialect) {
  const values: (string | number)[] = [];
  return { values, bind(value: string | number) { values.push(value); return dialect === 'sqlite' ? '?' : `$${values.length}`; } };
}
const like = (value: string) => `%${value.replace(/[!%_]/g, '!$&')}%`;
export const jsonSearchText = (value: string) => JSON.stringify(value).slice(1, -1);
export function adminSessionSql(query: AdminSessionQuery, dialect: Dialect, page: boolean) {
  const { values, bind } = parameters(dialect), clauses: string[] = [];
  if (query.ownerId) clauses.push(`s.owner_id=${bind(query.ownerId)}`);
  if (query.from) clauses.push(`s.updated_at>=${bind(query.from)}`);
  if (query.to) clauses.push(`s.updated_at<${bind(query.to)}`);
  if (query.q) {
    const operator = dialect === 'sqlite' ? 'LIKE' : 'ILIKE';
    const event = dialect === 'sqlite' ? 'e.event' : 'e.event::text';
    clauses.push(`(s.title ${operator} ${bind(like(query.q))} ESCAPE '!' OR EXISTS (SELECT 1 FROM rufa_session_events e WHERE e.session_id=s.id AND ${event} ${operator} ${bind(like(jsonSearchText(query.q)))} ESCAPE '!'))`);
  }
  const id = dialect === 'sqlite' ? 's.id' : 's.id COLLATE "C"';
  if (page && query.cursor) clauses.push(`(s.updated_at<${bind(query.cursor.updatedAt)} OR (s.updated_at=${bind(query.cursor.updatedAt)} AND ${id}<${bind(query.cursor.id)}))`);
  const select = !page ? 'count(*) AS total' : dialect === 'sqlite' ? 's.*' : `s.*,to_char(s.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time`;
  const sql = `SELECT ${select} FROM rufa_sessions s${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''}${page ? ` ORDER BY s.updated_at DESC,${id} DESC LIMIT ${bind(query.limit + 1)}` : ''}`;
  return { sql, values };
}
export function adminOverviewSql(range: AdminRange, now: string, dialect: Dialect) {
  function bounds(column: string) {
    const { values, bind } = parameters(dialect), where: string[] = [];
    if (range.from) where.push(`${column}>=${bind(range.from)}`);
    if (range.to) where.push(`${column}<${bind(range.to)}`);
    return { condition: where.join(' AND ') || '1=1', values };
  }
  const account = parameters(dialect), deadline = account.bind(now);
  const expired = `(purged_at IS NOT NULL OR purge_after IS NULL OR purge_after<=${deadline})`;
  const sessions = bounds('updated_at'), usage = bounds('created_at');
  return {
    accounts: { sql: `SELECT count(*) AS total,COALESCE(SUM(CASE WHEN status='active' THEN 1 ELSE 0 END),0) AS active,COALESCE(SUM(CASE WHEN status='disabled' THEN 1 ELSE 0 END),0) AS disabled,COALESCE(SUM(CASE WHEN status='deleted' AND ${expired} THEN 1 ELSE 0 END),0) AS archived FROM rufa_users`, values: account.values },
    sessions: { sql: `SELECT count(*) AS total,COALESCE(SUM(CASE WHEN ${sessions.condition} THEN 1 ELSE 0 END),0) AS updated FROM rufa_sessions`, values: sessions.values },
    usage: { sql: `SELECT user_id,count(*) AS requests,COALESCE(SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END),0) AS completed,COALESCE(SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END),0) AS failed,COALESCE(SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END),0) AS cancelled,COALESCE(SUM(input_tokens),0) AS input_tokens,COALESCE(SUM(output_tokens),0) AS output_tokens,COALESCE(SUM(total_tokens),0) AS total_tokens,COALESCE(SUM(CASE WHEN input_tokens IS NULL OR output_tokens IS NULL OR total_tokens IS NULL THEN 1 ELSE 0 END),0) AS missing FROM rufa_usage WHERE ${usage.condition} GROUP BY user_id`, values: usage.values },
    users: { sql: 'SELECT u.id AS user_id,count(s.id) AS sessions FROM rufa_users u LEFT JOIN rufa_sessions s ON s.owner_id=u.id GROUP BY u.id ORDER BY u.id', values: [] },
  };
}
type Row = Record<string, any>;
export const emptyAdminUsage = (): AdminUsage => ({ requests: 0, completed: 0, failed: 0, cancelled: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, missingUsageRequests: 0 });
export function adminOverviewResult(accounts: Row, sessions: Row, usageRows: Row[], users: Row[]): AdminOverview {
  const usage = emptyAdminUsage();
  const byUser = new Map(usageRows.map(row => [row.user_id, {
    requests: Number(row.requests), completed: Number(row.completed), failed: Number(row.failed), cancelled: Number(row.cancelled),
    inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens), totalTokens: Number(row.total_tokens), missingUsageRequests: Number(row.missing),
  }]));
  for (const item of byUser.values()) for (const key of Object.keys(usage) as (keyof AdminUsage)[]) usage[key] += item[key];
  const total = Number(accounts.total), active = Number(accounts.active), disabled = Number(accounts.disabled), archived = Number(accounts.archived);
  return { accounts: { total, active, disabled, archived, recycled: total - active - disabled - archived }, sessions: { total: Number(sessions.total), updatedInRange: Number(sessions.updated) }, usage,
    users: users.map(row => { const { requests, inputTokens, outputTokens, totalTokens, missingUsageRequests } = byUser.get(row.user_id) ?? emptyAdminUsage(); return { userId: row.user_id, sessions: Number(row.sessions), requests, inputTokens, outputTokens, totalTokens, missingUsageRequests }; }),
  };
}
